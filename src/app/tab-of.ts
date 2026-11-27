// 底栏：哪些路由显示底栏、选中哪个页签、“＋”新建什么。每页归哪、“＋”是什么都写在 router.ts 的路由层级表 LEVELS 里，这里只照表推
// • 今天、日历（#/calendar、月份子页 #/cal/…、纪念日 #/anniv 选中“日历”）、待办、随手记四页显示；别的页（编辑、设置、提醒……）不显示
// • “＋”：今天、日历新建日程，待办新建待办；随手记页点“＋”直接把光标放进页面底部的输入行，
//   记下的就是随手记（App.tsx 调随手记页往 kit/state/new-item.ts 的 notesInput 登记的聚焦，不开打字条）
// • 隐私记页归随手记页签，记录页（新建、编辑）不显示底栏；“＋”同样调 notesInput.focus，隐私记页登记的是“打开隐私记的新建页”
// • 纪念日页：归日历页签，“＋”直接进纪念日新建页，不开打字条
import { levelBar, type Level, type RouteName, type TabName } from './router.ts';

/**
 * 这一页的底栏就是 LEVELS 的 bar 那一行原样（不另拷一份）：tab 选中哪个页签、add “＋”新建什么；
 * hold 没写就是能按住“＋”说话，写了 false 的不能（隐私记页录下的会进普通随手记、纪念日页录下的会变成日程）——App 读的时候默认 true，底栏和“＋”上方的气泡都看它
 */
export type TabBarFor = NonNullable<Level['bar']>;

/** sub：路径里名字后面第一段（#/vault/abc 的 'abc'），没有就是 ''；LEVELS 的 bar.subs 写了就只有这几个子页显示 */
export const tabBarFor: (route: RouteName, sub?: string) => TabBarFor | null = levelBar;

/** App 实际画的那一份：多了“不亮页签”（tab 为 null）这一种 */
export type ShownBar = Omit<TabBarFor, 'tab' | 'subs'> & { tab: TabName | null };

/**
 * 网页版宽屏的设置页、最近删除（左边也显示侧栏）：不亮页签，“＋”和今天页一样新建日程、按住能说话。
 * App 在宽屏、这一页没有页签但 LEVELS 写了 dock（router.ts 的 dockOf）时用；这两页不算页签页，宽屏进出它们怎么换见 page-anim.ts
 */
export const SETTINGS_DESK_BAR: ShownBar = { tab: null, add: 'event' };

// 两个路由之间起哪种过渡在 page-anim.ts（首屏不带）
