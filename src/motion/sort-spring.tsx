// 拖动排序期间列表让位用弹簧（R-461）：kit 的 SortBox 在拖动中（含松手后落下）包一层 <SortSpring on>，
// 里面 AppearItem（动画实现 list-impl.tsx）的 layout 过渡换成 tokens 的 spring（刚度 380、阻尼比 0.78，能被下一次换位打断、不晚两帧），
// 平时的增删照旧 tr.ui。只依赖 react
import { createContext, useContext, type ReactNode } from 'react';

const Ctx = createContext(false);

export function SortSpring({ on, children }: { on: boolean; children: ReactNode }) {
  return <Ctx.Provider value={on}>{children}</Ctx.Provider>;
}

/** 这一项此刻在不在拖动排序的让位里 */
export const useSortSpring = (): boolean => useContext(Ctx);
