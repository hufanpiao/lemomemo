// 只有懒加载的页面才用的几个路由函数，从 router.ts 挪出来、不进首屏（R-372 首屏额度）：
// 日历的 replaceInPage（日历内部一律原地换，R-372 ②）、编辑页的 replaceAddress。历史的 state、深度、编号仍由 router.ts 管
import { commit, hrefOf, noteEntry, stateFor, type RouteName } from './router.ts';


/**
 * 同一页面里换参数（月历翻月翻周、“今天”、年月选择、点某天进周视图、非法参数规整）：原地换这条历史，**不起 View Transition**，直接画新状态。
 * 日历内部算同一层（R-372 ②，负责人选“算同一层（推荐）”）：不记步数，左滑直接回到进日历之前那一层。
 * 页面自己决定要不要动（月历按钮翻页横滑、滑动跟手、键盘和“今天”直接切换，架构 5.12 第 3 点“动效”；B2 FA-3 代码复审 N1）
 */
export function replaceInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState(stateFor(0), '', href);
    noteEntry();
  }, 'none');
}

/** 只改地址、不重画（新建保存后把 #/todo/new 换成这一条的 id，代码审查 S7）；深度不变 */
export function replaceAddress(name: RouteName, ...params: string[]): void {
  window.history.replaceState(stateFor(0), '', hrefOf(name, ...params));
  noteEntry();
}
