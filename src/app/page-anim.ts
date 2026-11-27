// 切页起哪种过渡的规则（router.ts 的 setAnimOf 注入），所有情形只在这一处判断。
// 首屏不带它：首屏画完以后和横滑同一块下载（tab-swipe.ts 转出）。
// • 同一页（登记了 samePageAs 的页面组）里换地址：none 直接画。编辑层自己从底部滑上来，再叠整页动画是两层；
//   编辑层挂上时锁滚动，过渡途中 WebKit 会整页崩。别的同名路由（#/event/1 → #/event/2）照旧是换页
// • 页签互切（两头都有底栏、页签不同）：fade 原地模糊淡换，不分方向
// • 网页版宽屏（MQ_DESK_WIDE，在换页那一刻读）：
//   - 设置里换层：part，侧栏、左目录、页头、AI 栏不动，只把右边详情那一栏原地模糊淡换
//   - 没有页签、宽屏照样画侧栏的页（LEVELS 写了 dock、没有 bar）和别的有侧栏的页之间：fade
// • 别的（进编辑页、提醒……；手机、窄屏上进出设置和最近删除）：push 整页推页
import { MQ_DESK_WIDE } from '../kit/hooks/useMedia.ts';
import type { FeatureRoute } from './features.ts';
import { LEVELS, levelBar, setAnimOf, type Anim, type Route, type RouteName } from './router.ts';

/** 页面归属：samePageAs 指向的那条，没写就是自己（routes 装的时候给；不引 features.ts，免得登记表被拆出首屏主块） */
let routes: readonly FeatureRoute[] = [];
const pageOf = (name: RouteName): RouteName => routes.find((r) => r.name === name)?.samePageAs ?? name;
/** 登记了 samePageAs 的页面组；只有这些页在页内前进 / 后退时不起动画 */
const grouped = (name: RouteName): boolean => routes.some((r) => r.samePageAs === pageOf(name));
// 不引 tab-of.ts（tabBarFor 也是照 levelBar）：引了 Rolldown 会把 motion 的几个小模块拆出首屏主块
const barOf = (r: Route) => levelBar(r.name, r.params[0]);
/** 宽屏也画侧栏、但不亮页签的页（设置、最近删除） */
const dockOnly = (r: Route): boolean => barOf(r) === null && Boolean(LEVELS[r.name].dock);
const sided = (r: Route): boolean => barOf(r) !== null || dockOnly(r);
const deskWide = (): boolean => window.matchMedia?.(MQ_DESK_WIDE).matches === true;

export function animFor(a: Route, b: Route, wide = deskWide()): Anim {
  if (grouped(a.name) && pageOf(a.name) === pageOf(b.name)) return 'none';
  if (wide && a.name === 'settings' && b.name === 'settings') return 'part';
  const x = barOf(a);
  const y = barOf(b);
  if (x && y && x.tab !== y.tab) return 'fade';
  return wide && (dockOnly(a) || dockOnly(b)) && sided(a) && sided(b) ? 'fade' : 'push';
}

/** App 首屏画完以后调一次（tab-swipe.ts 转出），给它功能登记表 */
export function installPageAnim(all: readonly FeatureRoute[]): void {
  routes = all;
  setAnimOf(animFor);
}
