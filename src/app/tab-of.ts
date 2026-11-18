// 底栏（B2 FA-7）：哪些路由显示底栏、选中哪个页签、“＋”新建什么（负责人 11-05 ②③）
// • 今天、日历（#/calendar、月份子页 #/cal/…、纪念日 #/anniv，B5 视觉稿 38 选中“日历”）、待办、随手记四页显示；别的页（编辑、设置、提醒……）不显示
// • “＋”：今天、日历新建日程，待办新建待办；随手记页（R-380，定稿 R-117 / 线框“低 1”）点“＋”直接把光标放进页面底部的输入行，
//   记下的就是随手记（App.tsx 调随手记页往 kit/state/new-item.ts 的 notesInput 登记的聚焦，不开打字条）
// • 隐私记页（B5 D14）归随手记页签；“＋”同样调 notesInput.focus，隐私记页登记的是“打开隐私记的新建页”
// • 纪念日页（负责人 11-14 22:17：“纪念日页面的新建按钮去掉，在纪念日页面按+默认新建纪念日”）：归日历页签，“＋”直接进纪念日新建页，不开打字条
import { TAB_ORDER, type TabName } from '../kit/components/GlassBar/tabs.ts';
import type { RouteName } from './router.ts';

export interface TabBarFor {
  tab: TabName;
  add: 'event' | 'todo' | 'note' | 'anniv' | null;
  /** 能不能按住“＋”说话：隐私记页（录下的会进普通随手记）、纪念日页（录下的会变成日程）不能；App 的底栏和“＋”上方的气泡都看这一项 */
  hold: boolean;
}

const TAB_OF: Partial<Record<RouteName, TabName>> = { today: 'today', calendar: 'calendar', cal: 'calendar', anniv: 'calendar', todos: 'todos', notes: 'notes', vault: 'notes' };
const ADD_OF: Record<TabName, TabBarFor['add']> = { today: 'event', calendar: 'event', todos: 'todo', notes: 'note' };
/** 个别页的“＋”和所在页签不同 */
const ADD_OF_ROUTE: Partial<Record<RouteName, TabBarFor['add']>> = { anniv: 'anniv' };

export function tabBarFor(route: RouteName): TabBarFor | null {
  const tab = TAB_OF[route];
  return tab ? { tab, add: ADD_OF_ROUTE[route] ?? ADD_OF[tab], hold: route !== 'vault' && route !== 'anniv' } : null;
}

/**
 * 两个路由之间是不是页签互切、往哪边（router.ts setTabSwitch 用；负责人 11-18 选切页方案 B“按底栏顺序左右滑入”）：
 * 两头都有底栏、页签不同才算；往底栏右边的页签走为 1（新页从右边进），往左为 -1；别的为 0
 */
export function tabDir(a: RouteName, b: RouteName): -1 | 0 | 1 {
  const x = tabBarFor(a);
  const y = tabBarFor(b);
  if (x === null || y === null || x.tab === y.tab) return 0;
  return TAB_ORDER.indexOf(y.tab) > TAB_ORDER.indexOf(x.tab) ? 1 : -1;
}
