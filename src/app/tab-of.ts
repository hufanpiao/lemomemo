// 底栏（B2 FA-7）：哪些路由显示底栏、选中哪个页签、“＋”新建什么（负责人 11-05 ②③）
// • 今天、日历（#/calendar、月份子页 #/cal/…、纪念日 #/anniv，B5 视觉稿 38 选中“日历”）、待办、随手记四页显示；别的页（编辑、设置、提醒……）不显示
// • “＋”：今天、日历新建日程，待办新建待办；随手记页（R-380，定稿 R-117 / 线框“低 1”）点“＋”直接把光标放进页面底部的输入行，
//   记下的就是随手记（App.tsx 调随手记页往 kit/state/new-item.ts 的 notesInput 登记的聚焦，不开打字条）
// • 隐私记页（B5 D14）归随手记页签；“＋”同样调 notesInput.focus，隐私记页登记的是“打开隐私记的新建页”
import type { TabName } from '../kit/components/GlassBar/GlassBar.tsx';
import type { RouteName } from './router.ts';

export interface TabBarFor {
  tab: TabName;
  add: 'event' | 'todo' | 'note' | null;
}

const TAB_OF: Partial<Record<RouteName, TabName>> = { today: 'today', calendar: 'calendar', cal: 'calendar', anniv: 'calendar', todos: 'todos', notes: 'notes', vault: 'notes' };
const ADD_OF: Record<TabName, 'event' | 'todo' | 'note' | null> = { today: 'event', calendar: 'event', todos: 'todo', notes: 'note' };

export function tabBarFor(route: RouteName): TabBarFor | null {
  const tab = TAB_OF[route];
  return tab ? { tab, add: ADD_OF[tab] } : null;
}
