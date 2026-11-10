// 设置二级页、三级页的“从上一层点进来的”记号（提醒接线代码审查 H1、M1，复审第二轮 N1、L7）：navigateSub、isSubEntry、backOrReplace。
// 从 router.ts 挪出来、不进首屏（R-372 首屏额度）：只有设置页、+ 设置、关于、告知页这些懒加载的页面用；历史的 state、深度、编号仍由 router.ts 管
import { animTo, canGoBack, commit, depthNow, entryAt, goBack, hrefOf, noteEntry, replaceRoute, stateFor, stateOf, type RouteName } from './router.ts';

// “这一条历史是从上一层点进来的”（设置的二级页、三级页；提醒接线代码审查 H1、M1）：记在那条历史自己的 history.state 上，
// 浏览器前进后退、刷新、去别的页再回来都跟着那条历史走；页面里点“‹ 返回”时看它决定退一步（goBack）还是原地换成上一层（replaceRoute）。
// 记号的值是压这一条时上一层的地址（复审第二轮 N1）：上一条后来被原地换成了别的页（直接打开的二级页点“‹ 设置”被 replace 成首页，
// 再“前进”回到三层页），goBack 就会跳过一层；所以返回前再对一下上一条现在的地址（entryAt，本标签页这次打开以来记的），对不上就不算
const SUB = 'lemoSub';

// 快速连点同一个入口（复审 L7）：页面切换包在 View Transition 里，pushState 要等回调才执行，开头的“地址一样就不压”拦不住第二下。
// 还在切的同一个地址直接返回那一次的 Promise；回调里压之前再看一次地址
let subInFlight: { href: string; done: Promise<void> } | null = null;

/** 同 navigate，但在新压的那条历史上记“是从上一层点进来的”（记的是上一层的地址，isSubEntry 读）；设置页的子页入口用 */
export function navigateSub(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  if (subInFlight?.href === href) return subInFlight.done;
  const done = commit(() => {
    if (window.location.hash === href) return;
    noteEntry();
    window.history.pushState(stateFor(1, { [SUB]: window.location.hash }), '', href);
    noteEntry();
  }, animTo(href)).finally(() => {
    if (subInFlight?.done === done) subInFlight = null;
  });
  subInFlight = { href, done };
  return done;
}

/**
 * 当前这条历史是不是 navigateSub 压进来的、上一条还是当时的上一层：是就该 goBack；
 * 不是（直接打开、被 replace 过、上一条后来被换成了别的页）就原地换成上一层。旧版记号是 true（没记地址），照旧当是
 */
export function isSubEntry(): boolean {
  const mark = stateOf(SUB);
  if (mark === true) return true;
  if (typeof mark !== 'string') return false;
  const before = entryAt.get(depthNow() - 1);
  return before === undefined || before === mark;
}

/**
 * 子页的“‹ 返回”（设置的二级页、三级页）：回到上一层 name/params。
 * • 是点进来的、上一条还是上一层（isSubEntry）：退一步，和侧滑同一条路
 * • 是点进来的，但上一条后来被换成了别的页（N1）：照样退一步（不多压、不叠历史），退到的那一条在 popstate 里（hashchange 之前，
 *   不会先画出那一页）原地换成上一层；那一条不带记号，它的上一条不是它的上一层，再点返回就原地换
 * • 没有记号（直接打开、被 replace 过）：原地换成上一层，不多压一条
 * • 这一条不是这次载入里 App 压的（canGoBack 为假：iOS 恢复后只剩这一条、刷新后第一次返回）：原地换成上一层，不退出 App
 * 记号是地址时一律挂上 popstate 修正（审查 S-L1）：刷新以后 entryAt 是空的，isSubEntry 判不出上一条被换过，
 * 退到的那一条地址对得上时修正什么都不做，对不上就换成上一层，所以中途刷新也不跳层。
 * 修正只认这一次后退（审查 S-L2）：退到的深度必须是退之前减 1；约 1 秒内没派出 popstate 就自己摘掉，不留到之后不相干的后退
 */
export const BACK_FIX_MS = 1000;
export function backOrReplace(name: RouteName, ...params: string[]): void {
  const mark = stateOf(SUB);
  // 这一条不是这次载入里 App 压的（canGoBack 为假：iOS 主屏幕版被系统杀掉后恢复，只剩这一条和它的 state；刷新以后）：退一步可能退出 App，
  // 不论有没有记号都原地换成上一层
  if (mark === true && canGoBack()) {
    // 旧版记号（没记地址）：照旧当是点进来的，退一步
    goBack();
    return;
  }
  const href = hrefOf(name, ...params);
  if (typeof mark !== 'string' || !canGoBack()) {
    void replaceRoute(name, ...params);
    return;
  }
  const want = depthNow() - 1;
  const fix = (): void => {
    window.clearTimeout(timer);
    if (depthNow() !== want || window.location.hash === href) return;
    window.history.replaceState(stateFor(0), '', href);
    noteEntry();
  };
  const timer = window.setTimeout(() => window.removeEventListener('popstate', fix), BACK_FIX_MS);
  window.addEventListener('popstate', fix, { once: true });
  goBack();
}
