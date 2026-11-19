// 功能 todos：待办（todos）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  // preload：冷启动首屏画完后 App 在后台先下载（负责人 11-18，app/features.ts 的 preloadPages）
  { name: 'todos', Page: lazy(() => import('./ui/TodosPage.tsx')), preload: () => import('./ui/TodosPage.tsx') },
  // 待办编辑页（B2 FA-2）：#/todo/<id>、#/todo/new
  // warm：“＋”打开打字条时先下载（“展开编辑”要进的新建页，app/features.ts 的 warmRoute）
  // 编辑页也在冷启动后后台先下载（负责人 11-19 晚录屏“冷启动进入待办的时候也很卡”：冷启动后第一次点开一条待办要现下载这一块，黑约 0.75 秒）
  { name: 'todo', Page: lazy(() => import('./ui/TodoEditPage.tsx')), preload: () => import('./ui/TodoEditPage.tsx'), warm: () => import('./ui/TodoEditPage.tsx') },
] as const;

/** 今天页待办行就地展开、收起、勾选子任务（R-442；props 见 ui/InlineSubtasks.tsx）；没有子任务时什么都不画。在待办列表页那一包里（不另拆分包） */
export const InlineSubtasks = lazy(() => import('./ui/inline-subs.ts'));

/** 日历日清单里的待办组“● 待办 · N”（R-443：就地完成、展开子任务；props 见 ui/DayTodos.tsx）；这一天没有待办时只挂提示条。在待办列表页那一包里 */
export const DayTodos = lazy(() => import('./ui/day-todos.ts'));

/** 电脑今天页的详情抽屉里的待办编辑器（B6 返工）：props 是 id、onCreated（在不在抽屉里由 kit EditShell 的 useInDrawer 看）；在待办编辑页那一包里 */
export const TodoDrawerEditor = lazy(() => import('./ui/todo-drawer.ts'));

/** 完成满 7 天、没再动过的待办自动删除（负责人 11-15 方案）：app/main.tsx 在同步第一次拉取成功以后下载这一块、调 runTodoAutoDel 扫一遍。
 *  拿的是一个函数不是组件，lazy 包不了：A27 受控例外（build/eslint-rules/feature-index-exports.js 的 LOADERS） */
export const loadTodoAutoDel = () => import('./data/todo-autodel.ts');

/** 设置首页“完成 7 天后自动删除”一行（开关；键和默认值只在 data/todo-autodel.ts 一处）；没有 props */
export const TodoSettings = lazy(() => import('./ui/TodoSettings.tsx'));
