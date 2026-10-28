// React 一侧的“减少动态效果”（UI-4 M-1）：和函数一侧读同一个判断（./reduced.ts），data-rm 或系统设置变了会重新渲染。
// 不用 motion/react 的 useReducedMotion()：它只认系统设置，不认设置里的开关
import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from './reduced.ts';

export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}
