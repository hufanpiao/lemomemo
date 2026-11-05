// 底栏（B2 FA-7）：哪些路由显示底栏、选中哪个页签、“＋”新建什么（负责人 11-05 ②③）
// • 今天、日历（#/calendar 和月份子页 #/cal/…）、待办、随手记四页显示；别的页（编辑、设置、提醒……）不显示
// • “＋”：今天、日历新建日程，待办新建待办；随手记 B2 还没上线，不出“＋”
import type { TabName } from '../kit/components/GlassBar/GlassBar.tsx';
import type { RouteName } from './router.ts';

export interface TabBarFor {
  tab: TabName;
  add: 'event' | 'todo' | null;
}

const TAB_OF: Partial<Record<RouteName, TabName>> = { today: 'today', calendar: 'calendar', cal: 'calendar', todos: 'todos', notes: 'notes' };
const ADD_OF: Record<TabName, 'event' | 'todo' | null> = { today: 'event', calendar: 'event', todos: 'todo', notes: null };

export function tabBarFor(route: RouteName): TabBarFor | null {
  const tab = TAB_OF[route];
  return tab ? { tab, add: ADD_OF[tab] } : null;
}
