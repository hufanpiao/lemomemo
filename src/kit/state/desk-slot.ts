// 侧栏底部给电脑版布局“⋯”留的位置（B6，5.9b）：GlassBar 的空 span 用 ref 登记进来，kit/components/DeskLayout 经 portal 把“⋯”放进去。
// 不在 DeskLayout 里 querySelector 一次了事：App 在“＋”就绪前后各画一个 GlassBar（App.tsx），侧栏会重新挂一次，旧的 span 就没了
// 纯 TS，很小；GlassBar 只引 setDeskSlot（进首屏），useDeskSlot 跟着 DeskLayout 的懒加载块走
import { useSyncExternalStore } from 'react';

let slot: Element | null = null;
const subs = new Set<() => void>();

/** GlassBar 的 ref 回调：挂上给元素、卸下给 null */
export function setDeskSlot(el: Element | null): void {
  if (el === slot) return;
  slot = el;
  subs.forEach((f) => f());
}

/** 现在侧栏上的那个位置；窄屏（没侧栏）时元素还在但 display: none，“⋯”跟着不显示 */
export function useDeskSlot(): Element | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => slot,
  );
}
