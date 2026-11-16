// 拖动排序时“被拿起的那一条”（R-429 评审第 1、6 条）：kit 的 useSortDrag 拿起时设、收尾完清；列表 AppearItem（门面和实现）按行上的 data-sort-id 认。
// 从拿起到浮层收掉，这一条的行（含拖动中、放下后新挂上的元素、跨组时退场中的旧元素）：
// • 打 data-sort-lifted（SortDrag.module.css：看不见、高度照占，就是空位）——由渲染带上，不靠事后补属性，换了元素也一样
// • 不参与 layout 动画（实现那边固定 layoutDependency，Motion 不给它拍快照）：放下重排后它直接在新位置，浮层滑过去再撤，不会先跳回原位再滑
// • 新挂上的直接显示、不播淡入（跨组时目标组里新挂上的那一行）
// • 这期间门面不换成动画实现（swap-guard 的 holdBegin）：换实现要把整个列表子树重挂一次，拖着的行会变成新元素
//   （拿起时补发给左滑的那一下 pointercancel 会让守卫以为手指已经抬起，评审第 1 条查到的重挂就是这个）
// 只依赖 react，进首屏（很小）
import { useSyncExternalStore } from 'react';
import { holdBegin } from './swap-guard.ts';

let held: string | null = null;
let release: (() => void) | null = null;
const subs = new Set<() => void>();

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

/** 拿起 id 这一条（null = 放开）；同一时刻只有一条 */
export function holdSortRow(id: string | null): void {
  if (held === id) return;
  held = id;
  release?.();
  release = id === null ? null : holdBegin();
  for (const fn of [...subs]) fn();
}

/** 这一条现在是不是被拿着（不订阅：挂上那一刻判断用） */
export const isSortHeld = (id: string | undefined): boolean => id !== undefined && held === id;

/** 这一条是不是被拿着（拿起、放开时重画） */
export function useSortHeld(id: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isSortHeld(id), () => false);
}
