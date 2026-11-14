// 功能 todos：待办（todos）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
import { lazy } from 'react';

export const routes = [
  { name: 'todos', Page: lazy(() => import('./ui/TodosPage.tsx')) },
  // 待办编辑页（B2 FA-2）：#/todo/<id>、#/todo/new
  { name: 'todo', Page: lazy(() => import('./ui/TodoEditPage.tsx')) },
] as const;

/** 今天页待办行下面的子任务进度（R-350 方案 5.2：只显示“已勾/总数”和细进度条）；没有子任务时什么都不画。在待办列表页那一包里（不另拆分包） */
export const TodaySubtasks = lazy(() => import('./ui/today-subs.ts'));

/** 电脑今天页的详情抽屉里的待办编辑器（B6 返工）：props 是 id、onCreated（在不在抽屉里由 kit EditShell 的 useInDrawer 看）；在待办编辑页那一包里 */
export const TodoDrawerEditor = lazy(() => import('./ui/todo-drawer.ts'));
