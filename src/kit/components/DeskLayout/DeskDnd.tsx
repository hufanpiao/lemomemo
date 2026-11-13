// 电脑版布局拖面板（架构 5.9b 第 6 点）：dnd-kit 只准在这个目录里 import（ESLint no-restricted-imports）。
// • 只用鼠标 / 触控板（PointerSensor，按住把手挪 4px 才算拖，点一下不误拖）；键盘拖动、读屏播报在 DeskLayout.tsx 自己做（5.9b 第 5 点的
//   ↑↓ 本栏、← → 相邻栏同一高度、Esc 回原位，比 dnd-kit 的坐标式键盘移动可控），所以不注册 KeyboardSensor、不用它的播报
// • 跨栏：拖到别的栏上空（栏本身是 droppable，id 'col:<i>'）或别的块上，草稿布局（keepEmpty，途中不去空栏）就把它挪过去；放下才保存
// • 位移用 React 的 style（CSSOM，不受 CSP style-src-attr 限制）；过渡时长、曲线经 src/motion/desk.ts 取令牌，减少动态效果时不过渡
// • 拖动时原位置留虚框（data-dragging），手上的是 DragOverlay 里只画标题的小卡（不把面板内容复制一份）
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { deskSortTransition } from '../../../motion/gestures.ts';
import { useReducedMotionPref } from '../../../motion/components.ts';

const COL = 'col:';
export const colId = (i: number): string => `${COL}${i}`;

/** 落点：先看指针在哪个块或哪一栏里，没有再取最近的 */
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const panel = hits.find((h) => !String(h.id).startsWith(COL));
  return panel ? [panel] : hits.length ? hits : closestCenter(args);
};

/** over 换成“第几栏、整栏数组里第几个”；over 是栏本身时放到栏尾 */
export function dropTarget(overId: string, cols: readonly { panels: readonly string[] }[]): { col: number; idx: number } | null {
  if (overId.startsWith(COL)) {
    const col = Number(overId.slice(COL.length));
    const c = cols[col];
    return c ? { col, idx: c.panels.length } : null;
  }
  const col = cols.findIndex((c) => c.panels.includes(overId));
  return col < 0 ? null : { col, idx: cols[col]?.panels.indexOf(overId) ?? 0 };
}

export interface DndShellProps {
  disabled: boolean;
  onStart(id: string): void;
  onOver(id: string, overId: string): void;
  onEnd(id: string, overId: string | null): void;
  onCancel(): void;
  /** 手上那张小卡（拖着的块的标题），null 不画 */
  overlay: ReactNode;
  overlayClass: string | undefined;
  children: ReactNode;
}

export function DndShell({ disabled, onStart, onOver, onEnd, onCancel, overlay, overlayClass, children }: DndShellProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const quiet = { announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined } };
  return (
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={collide}
      accessibility={quiet}
      onDragStart={(e: DragStartEvent) => onStart(String(e.active.id))}
      onDragOver={(e: DragOverEvent) => e.over && onOver(String(e.active.id), String(e.over.id))}
      onDragEnd={(e: DragEndEvent) => onEnd(String(e.active.id), e.over ? String(e.over.id) : null)}
      onDragCancel={onCancel}
    >
      {children}
      <DragOverlay dropAnimation={null} {...(overlayClass ? { className: overlayClass } : {})}>
        {overlay}
      </DragOverlay>
    </DndContext>
  );
}

/** 一栏：可以放进来（空栏、栏尾的空白也能放），里面的块按竖排排序 */
export function DndCol({ index, ids, className, style, children, testId }: { index: number; ids: readonly string[]; className: string | undefined; style: CSSProperties; children: ReactNode; testId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: colId(index) });
  return (
    <SortableContext id={colId(index)} items={[...ids]} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className={className} style={style} data-over={isOver ? '' : undefined} data-testid={testId}>
        {children}
      </div>
    </SortableContext>
  );
}

/** 一块：把手是拖动的起点（setActivatorNodeRef），整块跟着挪 */
export function useDeskSortable(id: string, disabled: boolean) {
  const reduced = useReducedMotionPref();
  const s = useSortable({ id, disabled, transition: deskSortTransition(reduced) });
  const style: CSSProperties = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  // 只注册了 PointerSensor，起拖的监听只有 onPointerDown；按名字交出去（原生按钮上不用展开属性，A26）
  const onPointerDown = disabled ? undefined : (s.listeners?.['onPointerDown'] as ((e: PointerEvent<HTMLButtonElement>) => void) | undefined);
  return { ref: s.setNodeRef, handleRef: s.setActivatorNodeRef, onPointerDown, style, dragging: s.isDragging };
}
