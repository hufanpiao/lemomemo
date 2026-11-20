// 底栏（B2 FA-7）：哪些路由显示底栏、选中哪个页签、“＋”新建什么（负责人 11-05 ②③）。每页归哪、“＋”是什么都写在 router.ts 的路由层级表 LEVELS 里，这里只照表推
// • 今天、日历（#/calendar、月份子页 #/cal/…、纪念日 #/anniv，B5 视觉稿 38 选中“日历”）、待办、随手记四页显示；别的页（编辑、设置、提醒……）不显示
// • “＋”：今天、日历新建日程，待办新建待办；随手记页（R-380，定稿 R-117 / 线框“低 1”）点“＋”直接把光标放进页面底部的输入行，
//   记下的就是随手记（App.tsx 调随手记页往 kit/state/new-item.ts 的 notesInput 登记的聚焦，不开打字条）
// • 隐私记页（B5 D14）归随手记页签，记录页（新建、编辑）不显示底栏（11-20 记录页方向 A）；“＋”同样调 notesInput.focus，隐私记页登记的是“打开隐私记的新建页”
// • 纪念日页（负责人 11-14 22:17：“纪念日页面的新建按钮去掉，在纪念日页面按+默认新建纪念日”）：归日历页签，“＋”直接进纪念日新建页，不开打字条
import { TAB_ORDER } from '../kit/components/GlassBar/tabs.ts';
import { LEVELS, type Level, type Route, type RouteName, type TabName } from './router.ts';

export interface TabBarFor {
  tab: TabName;
  add: NonNullable<Level['bar']>['add'];
  /** 能不能按住“＋”说话：隐私记页（录下的会进普通随手记）、纪念日页（录下的会变成日程）不能；App 的底栏和“＋”上方的气泡都看这一项 */
  hold: boolean;
}

/** sub：路径里名字后面第一段（#/vault/abc 的 'abc'），没有就是 ''；LEVELS 的 bar.subs 写了就只有这几个子页显示 */
export function tabBarFor(route: RouteName, sub = ''): TabBarFor | null {
  const b = LEVELS[route].bar;
  if (!b || (b.subs && !b.subs.includes(sub))) return null;
  return { tab: b.tab, add: b.add, hold: b.hold ?? true };
}

const barOf = (r: Route): TabBarFor | null => tabBarFor(r.name, r.params[0]);

/**
 * 两个路由之间是不是页签互切、往哪边（router.ts setTabSwitch 用；负责人 11-18 选切页方案 B“按底栏顺序左右滑入”）：
 * 两头都有底栏、页签不同才算；往底栏右边的页签走为 1（新页从右边进），往左为 -1；别的为 0
 */
export function tabDir(a: Route, b: Route): -1 | 0 | 1 {
  const x = barOf(a);
  const y = barOf(b);
  if (x === null || y === null || x.tab === y.tab) return 0;
  return TAB_ORDER.indexOf(y.tab) > TAB_ORDER.indexOf(x.tab) ? 1 : -1;
}
