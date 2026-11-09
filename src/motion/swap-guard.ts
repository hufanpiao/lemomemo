// 门面换成动画实现的守卫（R-354 做法 A，方案第 2 节“到了以后什么时候换”）：
// 已经静态挂着的列表（今天页冷启动）要换成 motion 实现，换法是整个列表子树重挂一次（DOM 一样，画面上看不出来），
// 但重挂会丢掉焦点和行内的临时状态，所以三件事都满足才换，不满足就隔 SWAP_RETRY_MS 再看：
//   1. 焦点不在这个列表里；2. 没有按住不放的指针；3. 不在 useHoldView 停一拍的期间
// 只依赖 react，进首屏（很小）
import { useSyncExternalStore } from 'react';
import { motionImpl, subscribeMotionImpl, type MotionImpl } from './features.ts';

/** 守卫不满足时隔多久再看（ms） */
export const SWAP_RETRY_MS = 120;

const down = new Set<number>();
let watching = false;
let holds = 0;

/** 开始记按住的指针（第一个静态列表挂上时调；装一次，不拆：很便宜） */
export function watchPointers(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const up = (e: PointerEvent) => down.delete(e.pointerId);
  document.addEventListener('pointerdown', (e) => down.add(e.pointerId), true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  // 切走窗口时可能收不到 pointerup：清空，免得一直推迟
  window.addEventListener('blur', () => down.clear());
}

/** useHoldView 停一拍开始、结束时调 */
export function holdBegin(): () => void {
  holds += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds -= 1;
  };
}

/** 现在能不能把这个列表换成动画实现 */
export function canSwap(list: Element | null): boolean {
  if (down.size > 0 || holds > 0) return false;
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return !(list && a && list.contains(a));
}

/** 动画实现（没到时 null）；到了会重画一次 */
export function useMotionImpl(): MotionImpl | null {
  return useSyncExternalStore(subscribeMotionImpl, motionImpl, motionImpl);
}

/** 只给测试用 */
export function resetSwapGuardForTest(): void {
  down.clear();
  holds = 0;
}
