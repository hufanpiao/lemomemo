// 动效模块的第三个出口：跟手手势，只依赖 react、不带 motion/react。
// 不从 motion/index.ts 再导出：index.ts 被 main.tsx、router 引着，会把手势带进首屏入口块 main；单独一个出口，它们跟着用它们的懒加载块走
// 横向拖动的底层（锁方向、左边缘避让、跟手、滑完吞点按）：kit 左滑行 SwipeRow 用
export { lockOf, SIDE_PX, sideOf, useHDrag, type Axis, type HDrag, type HDragEnd } from './hdrag.ts';
// sideOf：四个主页面横滑切页签（app/tab-swipe.ts）和这里同一份左右切页带
// 左右滑动翻页（月历、周视图；底下是同一个 useHDrag）
export { flipMs, useSwipePager, type SwipePager } from './swipe-pager.ts';
// 上下拖动收起 / 展开（月历上拖收起）
export { useDragCollapse, type DragCollapse } from './drag-collapse.ts';
// 长按拿起、拖着走（拖动排序；kit 的 useSortDrag 用）
export { LIFT_MS, useLongPressDrag, type LongPressDragOptions, type Point } from './long-press-drag.ts';
// 长按出菜单（随手记分类胶囊、电脑版分类项、隐私记分类格）
export { useLongPress, type LongPressProps } from './long-press.ts';
// 拖动排序手里拿着的浮层（放大、跟手、倾斜、弹簧落下，见 sort-float.ts）
export { liftFloat, type SortFloat, type SortFloatOptions } from './sort-float.ts';
// 电脑版布局拖面板的位移过渡（只给 kit/components/DeskLayout 用，跟着电脑版布局的块走）
export { deskSortTransition, type SortTransition } from './desk-sort.ts';
