// 拖块的落点（DeskDnd.tsx 的 collide + dropTarget；B6 独立评审第 9 条）：
// • 同一栏里，在两块之间的空隙松手：落到离得最近的那一块的位置，不落到栏尾
// • 指针在栏尾的空白（最后一块下面）：算栏本身，放到栏尾（跨栏拖到栏尾照旧能放）
// • 指针在块上：就是那一块
import type { ClientRect, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { colId, collide, dropTarget } from '../DeskDnd.tsx';

type Args = Parameters<CollisionDetection>[0];

const rect = (top: number, bottom: number, left = 0, right = 300): ClientRect => ({ top, bottom, left, right, width: right - left, height: bottom - top });
const box = (id: string, containerId: string | null): DroppableContainer =>
  ({ id, key: id, disabled: false, data: { current: containerId ? { sortable: { containerId, index: 0, items: [] } } : undefined }, node: { current: null }, rect: { current: null } }) as unknown as DroppableContainer;

// 一栏（0～600）里三块：a 0～200、b 212～400、c 412～500，块之间 12px 空隙
const cols = [{ panels: ['a', 'b', 'c'] }];
const containers = [box(colId(0), null), box('a', colId(0)), box('b', colId(0)), box('c', colId(0))];
const rects = new Map<string | number, ClientRect>([
  [colId(0), rect(0, 600)],
  ['a', rect(0, 200)],
  ['b', rect(212, 400)],
  ['c', rect(412, 500)],
]);

/** 拖着 a、指针在 y：手上那块的框以指针为中心（高 200） */
function at(y: number): Args {
  return {
    active: { id: 'a', data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
    collisionRect: rect(y - 100, y + 100),
    droppableRects: rects,
    droppableContainers: containers,
    pointerCoordinates: { x: 150, y },
  } as unknown as Args;
}

const target = (y: number) => {
  const hit = collide(at(y))[0];
  return hit ? dropTarget(String(hit.id), cols) : null;
};

describe('拖块的落点', () => {
  it('同一栏两块之间的空隙：落到最近的那一块的位置（b，第 2 个），不放到栏尾', () => {
    expect(target(206)).toEqual({ col: 0, idx: 1 });
  });

  it('指针在块上：就是那一块', () => {
    expect(target(450)).toEqual({ col: 0, idx: 2 });
  });

  it('栏尾的空白（最后一块下面）：算栏本身，放到栏尾', () => {
    expect(target(550)).toEqual({ col: 0, idx: 3 });
  });
});
