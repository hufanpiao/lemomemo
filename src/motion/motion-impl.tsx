// 动画实现＋功能包合成的一块（R-354，方案 docs/10-架构/方案-动画库移出首屏.md 做法 A，主持人 11-07 定）：
// • motion/react（m、AnimatePresence、LazyMotion、MotionConfig、LayoutGroup 这层壳）和功能包 domMax 都只在这一块里，
//   由 ./features.ts 的 loadMotionFeatures() 动态 import；main.tsx 在 appPainted() 之后调它，不进首屏（e2e 首屏预算口径）
// • 首屏上的 Appear、AppearList、AppearItem、SharedLayout 是只依赖 react 的门面（./Appear.tsx 等），
//   这一块到了以后门面在安全的时机换成这里的实现；实现本身和 FA-5、FA-6 调好的一行不改（./appear-impl.tsx 等）
// • default 导出功能包，给各个实现里的 LazyMotion 用（./features.ts 的 motionFeatures()）
export { domMax as default } from 'motion/react';
export { Appear, appearMotion } from './appear-impl.tsx';
export { AppearItem, AppearList, itemMotion } from './list-impl.tsx';
export { SharedLayout } from './shared-impl.tsx';
