// Motion 的功能包（架构 2.6、17.3）：LazyMotion + m 组件，按用途选包：
// 进出场只要 domAnimation；layoutId（同页元素衔接）要 domMax。
// motion/react 只被 ./components.ts 那几个组件用到，跟着用它们的页面一起懒加载，不进首屏（check_size 会看）
export { domAnimation as motionFeatures, domMax as motionLayoutFeatures } from 'motion/react';
