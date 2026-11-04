// App 外壳：按 hash 路由挂页面（各页面懒加载，A27）
// • 提醒（B2 FA-4，REMIND-wiring）：RemindHost 挂一份（横幅、按钮条、提醒引擎），在页面的错误边界外面、自己一个 Suspense，
//   提醒的分包没到、出错都不影响页面；key 用登录会话的 user_id（L8）：换账号就整个重新挂载，
//   引擎卸载时清掉模块级的“本次打开响过的”“本次会话只在本机处理过的”，不把上个账号的带过来。没登录（测试里没启动）不挂
import { lazy, Suspense } from 'react';
import { getBoot } from '../core/boot.ts';
import { RemindHost } from '../features/reminders/index.ts';
import { useT } from '../kit/hooks/useT.ts';
import { isProduction } from '../platform/env.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';
import { featureRoutes, offRoutes, type FeatureRoute } from './features.ts';
import { setSamePage, useRoute, type RouteName } from './router.ts';

// CSP 试验页（B0 第一项验证）：只在非正式版里挂
const devRoutes: readonly FeatureRoute[] = isProduction
  ? []
  : [{ name: 'dev-csp', Page: lazy(() => import('./dev/CspLab.tsx')) }];

function ErrorView() {
  const t = useT();
  return (
    <p role="alert" data-testid="app-error">
      {t('error.unknown', {})}
    </p>
  );
}

/** 功能开关关着的页面（hash 直接打开时）：不是出错（K6 审查 L11） */
function FeatureOffView() {
  const t = useT();
  return (
    <p role="status" data-testid="feature-off">
      {t('feature.off', {})}
    </p>
  );
}

/** 顶部版本横幅（UpdateBanner.tsx）：还没启动（测试里）、本机库来自更新的版本（整屏提示管）时不画 */
function Banner() {
  const boot = getBoot();
  if (!boot) return null;
  return <UpdateBanner upgrade={boot.upgrade} outbox={boot.outbox} onReload={reloadPage} />;
}

/** RemindHost 出错（渲染出错、分包加载失败）时记日志：App 不碰日志层，由入口（main.tsx）接上 js_error；没接时不记（接线审查 R2） */
let onRemindError: ((error: unknown) => void) | null = null;
export function setRemindErrorLog(fn: ((error: unknown) => void) | null): void {
  onRemindError = fn;
}
const logRemindError = (error: unknown): void => {
  try {
    onRemindError?.(error);
  } catch {
    // 日志出错不挡页面
  }
};

/**
 * 提醒横幅和引擎：按 user_id 作 key，换账号重新挂载（L8）；页面路由传给它（'today' 不画顶部横幅，'remind' 都不画）。
 * • 出错（接线审查 R2）：自己的错误边界只吞掉提醒这一块，页面照常；记一条 js_error（setRemindErrorLog）。
 *   这次打开不再重试（包括离线时分包加载失败），错误边界的 key 只在换账号时变；下次打开 App 重新挂。这是接受的取舍
 */
function Reminders({ route }: { route: RouteName }) {
  const userId = getBoot()?.userId ?? null;
  if (!userId) return null;
  return (
    <ErrorBoundary key={userId} fallback={null} onError={logRemindError}>
      <Suspense fallback={null}>
        <RemindHost route={route} />
      </Suspense>
    </ErrorBoundary>
  );
}

const allRoutes: readonly FeatureRoute[] = [...featureRoutes, ...devRoutes];
/** 页面归属：samePageAs 指向的那条，没写就是自己 */
const pageOf = (name: RouteName): RouteName => allRoutes.find((r) => r.name === name)?.samePageAs ?? name;
// 登记了 samePageAs 的页面组（目前只有月历：calendar + cal）；只有这些页在页内前进 / 后退时不起整页动画。
// 别的同名路由（#/event/1 → #/event/2）照旧是换页，不算（router.ts setSamePage，代码复审 R2）
const grouped = new Set(allRoutes.flatMap((r) => (r.samePageAs === undefined ? [] : [r.samePageAs])));
setSamePage((a, b) => grouped.has(pageOf(a.name)) && pageOf(a.name) === pageOf(b.name));

export function App() {
  const route = useRoute();
  const all = allRoutes;
  const found = all.find((r) => r.name === route.name);
  // samePageAs：#/calendar 和 #/cal/... 是同一个页面，挂同一个组件、错误边界用同一个 key，
  // 互相跳（月历点“下个月”）时不重新挂载，焦点留在按钮上（B2 FA-3 代码审查 M7）
  const hit = (found?.samePageAs !== undefined && all.find((r) => r.name === found.samePageAs)) || found;
  const Page = hit?.Page;
  const pageKey = hit?.name ?? route.name;
  // 横幅和页面放在同一个 Suspense 里：页面分包没到时一起不画，启动画面不会因为先画出横幅就提前收起（root.tsx 头注释）。
  // 代价（接线审查 R1）：切到一个分包还没加载过的页面时，外层 Suspense 把整块藏起来，正在显示的提醒横幅、按钮条会短暂消失，
  // 分包到了再出来；RemindHost 不卸载，队列和引擎状态都不丢。（首屏减重 ⑥ 改成空闲后挂、挪出这个 Suspense 后就没有这个代价）
  // 横幅在页面的错误边界外面（架构师 10-30 第 6 点）：页面出错显示 ErrorView 时横幅还在；横幅自己出错只是不画横幅
  return (
    <Suspense fallback={null}>
      <ErrorBoundary fallback={null}>
        <Banner />
      </ErrorBoundary>
      <ErrorBoundary key={pageKey} fallback={<ErrorView />}>
        {Page ? <Page /> : offRoutes.has(route.name) ? <FeatureOffView /> : <ErrorView />}
      </ErrorBoundary>
      <Reminders route={route.name} />
    </Suspense>
  );
}
