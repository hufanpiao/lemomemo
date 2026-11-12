// 动效模块的 React 组件（架构 17.2 第 4 点）。函数接口见 ./index.ts
export { Appear } from './Appear.tsx';
export { Pressable } from './Pressable.tsx';
export { SharedLayout } from './SharedLayout.tsx';
export { Celebrate } from './Celebrate.tsx';
export { useReducedMotionPref } from './useReducedMotionPref.ts';
export { AppearList, AppearItem } from './AppearList.tsx';
// 打勾停一拍再挪走：留住按下之前的那一份 --dur-ui（B2 FA-5 设计审查 M1）
export { useHoldView } from './useHoldView.ts';
// 每帧跑一次的循环（B3 FA-3 录音面板的计时、声波；不从 index.ts 出，理由见 frame-loop.ts）
export { eachFrame } from './frame-loop.ts';
