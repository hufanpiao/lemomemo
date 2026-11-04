// App 外壳：按 hash 路由挂页面（各页面懒加载，A27）
// • 提醒（B2 FA-4，REMIND-wiring）：RemindHost 挂一份（横幅、按钮条、提醒引擎），在页面的 Suspense 和错误边界外面、自己一个 Suspense，
//   提醒的分包没到、出错都不影响页面；key 用登录会话的 user_id（L8）：换账号就整个重新挂载，
//   引擎卸载时清掉模块级的“本次打开响过的”“本次会话只在本机处理过的”，不把上个账号的带过来。没登录（测试里没启动）不挂
// • 首屏减重 ⑥：页面画出来以后、浏览器空闲时才挂 RemindHost（约 14 KB 提醒代码不在首屏路径上）；冷启动就是整页提醒（点系统通知进来）时立刻挂。
//   since（从哪一刻起到点的进横幅）在 App 第一次渲染时记下，打开到挂上之间到点的照样响，只是晚响这一会儿：
//   页面分包到达并提交 + whenIdle（requestIdleCallback 最多 2 秒，没有时 300 ms）+ 下载 RemindHost 分包；后台标签页的定时器还会被节流。
//   另有和页面无关的硬上限 REMIND_MAX_WAIT_MS（5 秒，从 App 第一次渲染算起）：页面分包一直不到、一直不提交，也最晚这时挂上
//   （这时页面可能还是空白，到点的横幅会先画出来、启动画面随之收起；比一直不响好，接线审查⑥ L3 接受的取舍）
import { lazy, Suspense, useEffect, useState } from 'react';
import { getBoot } from '../core/boot.ts';
import { RemindHost } from '../features/reminders/index.ts';
import { useT } from '../kit/hooks/useT.ts';
import { isProduction } from '../platform/env.ts';
import { clock } from '../platform/clock.ts';
import { whenIdle } from '../platform/session.ts';
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
function Reminders({ route, ready }: { route: RouteName; ready: boolean }) {
  const userId = getBoot()?.userId ?? null;
  if (!userId) return null;
  return <RemindersFor key={userId} route={route} ready={ready} />;
}

/** 一个账号的提醒：since 在第一次渲染（App 打开、换账号）时记下；ready 之前不渲染 RemindHost，分包也不下载 */
function RemindersFor({ route, ready }: { route: RouteName; ready: boolean }) {
  const [since] = useState(() => clock.now());
  if (!ready) return null;
  return (
    <ErrorBoundary fallback={null} onError={logRemindError}>
      <Suspense fallback={null}>
        <RemindHost route={route} since={since} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** 提醒最晚什么时候挂：从 App 第一次渲染算起，不管页面有没有画出来（接线审查⑥ L3） */
export const REMIND_MAX_WAIT_MS = 5000;
/** 硬上限的定时器：单独一个对象，测试 spy 它（不去拦全局 setTimeout，接线审查⑥ N2） */
export const remindMaxWait = {
  start: (fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, REMIND_MAX_WAIT_MS),
  stop: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
};

/** 放在页面的 Suspense 里：页面真提交了（分包到了、画出来了）才跑 effect，再等浏览器空闲，通知 App 可以挂提醒了 */
function ArmReminders({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    let cancelled = false;
    whenIdle(() => {
      if (!cancelled) onReady();
    });
    return () => {
      cancelled = true;
    };
  }, [onReady]);
  return null;
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
  // 提醒什么时候挂（首屏减重 ⑥）：冷启动就是整页提醒时立刻挂；否则等页面画出来、浏览器空闲（ArmReminders）。挂上以后不再收回
  const [remindReady, setRemindReady] = useState(() => route.name === 'remind');
  const [armRemind] = useState(() => () => setRemindReady(true));
  // 硬上限：页面一直不提交（分包挂着不成功也不失败）也最晚 REMIND_MAX_WAIT_MS 挂上
  useEffect(() => {
    if (remindReady) return;
    // 依赖里没有路由：换页不重新计时（接线审查⑥ N1）
    const t = remindMaxWait.start(armRemind);
    return () => remindMaxWait.stop(t);
  }, [remindReady, armRemind]);
  const all = allRoutes;
  const found = all.find((r) => r.name === route.name);
  // samePageAs：#/calendar 和 #/cal/... 是同一个页面，挂同一个组件、错误边界用同一个 key，
  // 互相跳（月历点“下个月”）时不重新挂载，焦点留在按钮上（B2 FA-3 代码审查 M7）
  const hit = (found?.samePageAs !== undefined && all.find((r) => r.name === found.samePageAs)) || found;
  const Page = hit?.Page;
  const pageKey = hit?.name ?? route.name;
  // 版本横幅和页面放在同一个 Suspense 里：页面分包没到时一起不画，启动画面不会因为先画出横幅就提前收起（root.tsx 头注释）。
  // 提醒在这个 Suspense 外面（首屏减重 ⑥）：要等页面提交、浏览器空闲才挂（冷启动整页提醒时那一页就是 remind 页面本身，横幅和按钮条都不画），
  // 不会抢在页面前面画出来；切到分包还没加载的页面时也不跟着页面藏起来（原来的接线审查 R1 没有了）
  // 横幅在页面的错误边界外面（架构师 10-30 第 6 点）：页面出错显示 ErrorView 时横幅还在；横幅自己出错只是不画横幅
  return (
    <>
      <Suspense fallback={null}>
        <ErrorBoundary fallback={null}>
          <Banner />
        </ErrorBoundary>
        <ErrorBoundary key={pageKey} fallback={<ErrorView />}>
          {Page ? <Page /> : offRoutes.has(route.name) ? <FeatureOffView /> : <ErrorView />}
        </ErrorBoundary>
        {!remindReady && <ArmReminders onReady={armRemind} />}
      </Suspense>
      <Reminders route={route.name} ready={remindReady} />
    </>
  );
}
