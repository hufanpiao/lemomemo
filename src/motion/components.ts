// 动效模块的 React 组件。函数接口见 ./index.ts
export { Appear, useEnter } from './Appear.tsx';
export { Pressable } from './Pressable.tsx';
export { SharedLayout } from './SharedLayout.tsx';
export { useReducedMotionPref } from './useReducedMotionPref.ts';
export { AppearList, AppearItem } from './AppearList.tsx';
// 拖动排序期间列表让位用弹簧（kit 的 SortBox 包）
export { SortSpring } from './sort-spring.tsx';
// 打勾停一拍再挪走：留住按下之前的那一份 --dur-ui
export { useHoldView } from './useHoldView.ts';
// 整页换排法（电脑版面板）等到没有焦点、没有按住的指针再换：和动画实现换上同一个守卫
export { useSwapWhenSafe } from './swap-guard.ts';
// 手指按着没有、最后一次抬起：全 app 一套监听
export { pointerHeld, resetPointersForTest, sincePointerUp, watchPointers } from './swap-guard.ts';
// 同一个“现在能不能动”的判断（按着、停一拍），后台预加载两页之间也用（app/preload-gap.ts）
export { canSwap, SWAP_RETRY_MS } from './swap-guard.ts';
// 每帧跑一次的循环（录音面板的计时、声波；不从 index.ts 出，理由见 frame-loop.ts）
export { eachFrame } from './frame-loop.ts';
// 一段时间内吞点按（kit CheckCircle 抬手切换以后吞系统补发的 click；同样不从 index.ts 出：CheckCircle 引 index.ts 会多拆出一个首屏块）
export { guardWindow } from './swallow-click.ts';
export { CHECK_CLICK_SWALLOW_MS, dur, TAP_SLOP_PX } from './tokens.ts';
