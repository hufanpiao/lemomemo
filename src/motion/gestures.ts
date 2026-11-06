// 动效模块的第三个出口（0.31 第 6 条，11-05 主持人定，原因是首屏体积）：跟手手势，只依赖 react、不带 motion/react。
// 原来从 motion/index.ts 再导出；index.ts 被 main.tsx、router 引着，rollup 就把这两个手势放进了入口块 main（约 1.6 KB gzip），
// 而用它们的只有月历（懒加载）。单独一个出口，它们就跟着月历的块走
// 左右滑动翻页（B2 FA-3 月历、周视图）
export { useSwipePager, type SwipePagerHandlers } from './swipe-pager.ts';
// 上下拖动收起 / 展开（B2 FA-3 月历上拖收起）
export { useDragCollapse, type DragCollapse } from './drag-collapse.ts';
