// 随手记列表行的左滑（B5 S7；线框 s7 NOTEROW_SW：“转成待办 / 移到隐私记 / 删除”；视觉稿 .swp；R-171、R-172、TC-B5-34）
// • 只在列表方式用（瀑布流不左滑，R-78）；同一时间只开一行（页面记着开着的是哪一行）
// • 左滑超过按钮总宽的一半松手就停在打开，否则收回；滑动过的那一下不算点按（不进编辑器）
// • 按钮：旁边两个浅色（浅色主题 --panel-2 底、--text 字；深色主题 --text-2 底、--panel 字；常规字重），“删除”警示色、半粗（R-171、R-172）
// • 收起时按钮不可聚焦（读屏、键盘走“⋯”菜单，同一套动作）；按钮排在行内容后面（Tab 顺序、行里第一个按钮仍是正文）
import { useRef, useState, type ReactNode } from 'react';
import styles from './NoteSwipe.module.css';

export interface SwipeAction {
  label: string;
  onClick(): void;
  danger?: boolean;
  testId: string;
}

const BTN_W = 64;
const SLOP = 8;

export function SwipeRow({ actions, open, onOpenChange, children, testId }: {
  actions: readonly SwipeAction[]; open: boolean; onOpenChange(open: boolean): void; children: ReactNode; testId: string;
}) {
  const width = actions.length * BTN_W;
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; y: number; base: number; horiz: boolean | null } | null>(null);
  const moved = useRef(false);
  const last = useRef<number | null>(null);
  const dx = drag ?? (open ? -width : 0);

  return (
    <div className={styles.swp} data-testid={testId} data-open={open || undefined}>
      <div
        className={drag === null ? `${styles.content} ${styles.settle}` : styles.content}
        style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          start.current = { x: e.clientX, y: e.clientY, base: open ? -width : 0, horiz: null };
          moved.current = false;
          last.current = null;
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (s.horiz === null) {
            if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return;
            s.horiz = Math.abs(mx) > Math.abs(my);
            if (s.horiz) e.currentTarget.setPointerCapture?.(e.pointerId);
          }
          if (!s.horiz) return;
          moved.current = true;
          last.current = Math.min(0, Math.max(-width, s.base + mx));
          setDrag(last.current);
        }}
        onPointerUp={() => {
          const s = start.current;
          start.current = null;
          // 松手读 ref 不读 drag：pointermove 是连续事件，React 可能还没重画，闭包里的 drag 会是旧值（e2e 负载高时偶发“滑开了又收回”）
          if (s?.horiz && last.current !== null) onOpenChange(last.current < -width / 2);
          last.current = null;
          setDrag(null);
        }}
        onPointerCancel={() => {
          start.current = null;
          last.current = null;
          setDrag(null);
        }}
        onClickCapture={(e) => {
          // 滑过的那一下、开着时点内容：只收回，不进编辑器
          // （滑开那一下松手后浏览器还会补一个 click：只吞掉，不能当“点内容”把刚滑开的又收回——e2e 实测 pointerup 后 open 已是 true）
          if (moved.current) {
            e.preventDefault();
            e.stopPropagation();
            moved.current = false;
          } else if (open) {
            e.preventDefault();
            e.stopPropagation();
            onOpenChange(false);
          }
        }}
      >
        {children}
      </div>
      <div className={styles.acts} aria-hidden={!open || undefined} style={{ width }}>
        {actions.map((a) => (
          <button
            key={a.testId}
            type="button"
            className={a.danger ? `${styles.act} ${styles.del}` : styles.act}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              onOpenChange(false);
              a.onClick();
            }}
            data-testid={a.testId}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
