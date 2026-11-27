// App 外壳：按 hash 路由挂页面（各页面懒加载）
// • 提醒：RemindHost 挂一份，在页面的 Suspense 和错误边界外面、自己一个 Suspense，分包没到、出错都不影响页面；
//   key 用 user_id：换账号整个重新挂载，不把上个账号的模块级状态带过来。没登录不挂
// • RemindHost 和冷启动预加载三页等 useAfterFirstPage（首屏画完、App 自己的页面显示着、浏览器空闲，最晚 5 秒）；
//   冷启动就是整页提醒时立刻挂。since 在 App 第一次渲染时记下，中间到点的照样响
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getBoot, type BootResult } from '../core/boot.ts';
import { RemindHost } from '../features/reminders/index.ts';
import { GlassBar } from '../kit/components/GlassBar/GlassBar.tsx';
import { useT } from '../kit/hooks/useT.ts';
import { useUi } from '../kit/state/ui-store.ts';
import { remindQueue, setRemindDown } from '../kit/state/remind-queue.ts';
import { clock } from '../platform/clock.ts';
import { JS_ERROR_ACT } from '../platform/env.ts';
import { logEvent } from '../../shared/core/log-bus.ts';
import { afterAppPainted } from '../platform/root-paint.ts';
import { whenIdle } from '../platform/session.ts';
import { rlog } from '../platform/run-log-api.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { bannerKind } from './banner-kind.ts';
import { featureRoutes, offRoutes, preloadPages, warmRoute, type FeatureRoute } from './features.ts';
import { goHref, hrefOf, LEVELS, navigate, useRoute, type RouteName } from './router.ts';
import { FADE_WAIT_MS, growSwap, whenMainShown } from '../motion/index.ts';
import { preloadGap } from './preload-gap.ts';
import { PagePending } from '../kit/components/PagePending.tsx';
import { SETTINGS_DESK_BAR, tabBarFor, type ShownBar } from './tab-of.ts';
import { MQ_DESK_WIDE, useMedia } from '../kit/hooks/useMedia.ts';
import { PlusSlot, plusHold, preloadPlus } from './plus-slot.tsx';
import type { DateStr } from '../../shared/core/date.ts';
import { calendarSel, notesInput, setNewItem } from '../kit/state/new-item.ts';

// CSP 试验页只在非正式版里挂。用构建期常量 import.meta.env.MODE，正式构建时整块删掉（运行时的 isProduction 删不掉）；
// build/check_no_probe.mjs 断言正式产物里没有它
const devRoutes: readonly FeatureRoute[] = import.meta.env.MODE === 'production'
  ? []
  : [{ name: 'dev-csp', Page: lazy(() => import('./dev/CspLab.tsx')) }];

function ErrorView() {
  const t = useT();
  return (
    <main data-feature="error">
      <p role="alert" data-testid="app-error">
        {t('error.unknown', {})}
      </p>
    </main>
  );
}

/**
 * 底栏：显示在哪些页、选中哪个、“＋”新建什么见 tab-of.ts。
 * 在页面的 Suspense 外面：切到分包没到的页时底栏不跟着藏。
 * App 自己的第一个页面出现以前不画，出现以后一直画
 */
function TabBar({ route, sub }: { route: RouteName; sub: string }) {
  const t = useT();
  const [paged, setPaged] = useState(false);
  useEffect(() => (paged ? undefined : whenMainShown(() => setPaged(true))), [paged]);
  // 首屏画完以后才下载的一块（tab-swipe.ts 的 installAfterPaint，合成一个 import()）：
  // • 视口监听（platform/viewport.ts）：写根节点的 --kb、data-kbo、data-kbhide，键盘弹着时底栏和“＋”由样式藏起；顺带拦 iOS 整页双指缩放
  // • 四个主页面左右划切页签（tab-swipe.ts）、所有页面顶部固定（platform/top-lock.ts）
  // • 切页过渡规则（page-anim.ts）：装上以前换页一律直接画
  // 同时并行下载打字条（plus-slot.tsx 的 preloadPlus）
  useEffect(() => {
    let stop = (): void => undefined;
    let off = false;
    afterAppPainted(() => {
      preloadPlus();
      import('./tab-swipe.ts')
        .then((m) => {
          if (!off) stop = m.installAfterPaint(allRoutes);
        })
        .catch(() => undefined);
    });
    return () => {
      off = true;
      stop();
    };
  }, []);
  // “＋”点一下打开打字条；open 时记着日历页选中的那天
  const [plus, setPlus] = useState<{ day: DateStr | null } | null>(null);
  // 换页就收起，但等新页面的 <main> 真的显示出来再收：新页分包没到时先收，屏幕上会是一段空白或原页面
  // 打字条“详细”正在长成新建页时由 expand 收，这里不收
  const growing = useRef(false);
  // 分包没到时最多等 FADE_WAIT_MS 也收
  useEffect(() => whenMainShown(() => !growing.current && setPlus(null), FADE_WAIT_MS), [route]);
  // 网页版宽屏：有常驻 AI 栏的页（router.ts LEVELS 的 dock）也画侧栏、不亮页签（SETTINGS_DESK_BAR）；手机和窄屏没有底栏
  const deskWide = useMedia(MQ_DESK_WIDE);
  const bar: ShownBar | null = tabBarFor(route, sub) ?? (deskWide && LEVELS[route].dock ? SETTINGS_DESK_BAR : null);
  // 日历页：带上日历上选中的那天（日历页登记的 calendarSel，kit/state/new-item.ts）
  const open = (): void => {
    // 随手记页：“＋”直接把光标放进页面底部的输入行，不开打字条
    if (bar?.add === 'note') {
      notesInput.focus?.();
      return;
    }
    // 纪念日页：“＋”直接进纪念日新建页
    if (bar?.add === 'anniv') {
      void navigate('anniv', 'new');
      return;
    }
    // “展开编辑”要进的新建页先下载（features.ts 的 warmRoute），免得第一次展开卡一下
    if (bar?.add) void warmRoute(bar.add, rlog, () => performance.now());
    setPlus({ day: bar?.tab === 'calendar' ? (calendarSel.day?.() ?? null) : null });
  };
  // 展开编辑换到没有底栏的新建页：打字条还开着就沿用上一页的底栏设置只留打字条，等新页显示出来收起（不然会有十几帧两样都没有）
  const lastBar = useRef(bar);
  useEffect(() => {
    if (bar) lastBar.current = bar;
  });
  const shownBar = bar ?? (plus ? lastBar.current : null);
  // 没有底栏的页：根节点标 data-nobar，贴底浮条（--dock-bottom）由 base.css 落到离底 安全区 + 6
  const nobar = shownBar === null;
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-nobar', nobar);
  }, [nobar]);
  if (!shownBar || !paged) return null;
  // hold 没写就是能按住说话（tab-of.ts）
  const { tab, add, hold = true } = shownBar;
  if (add === null) return <GlassBar active={tab} later={afterAppPainted} />;
  // 展开成完整新建页：打的字和那天带过去（kit/state/new-item.ts，新建页挂上以后取走）
  const expand = (text: string, day: DateStr | null): void => {
    setNewItem({ title: text, day });
    // 不起整页过渡：过渡截的旧画面是没模糊的原页面，会先露出一帧（WebKit 过渡截图也不画 backdrop-filter）。
    // 改由打字条那张卡长成新建页（motion 的 growSwap）：旧页快照垫在模糊层下面，打字条淡出，长完再收打字条和模糊层
    // 正在长的时候再点“详细”不重来
    if (growing.current) return;
    const card = document.querySelector<HTMLElement>('[data-testid="type-bar"]');
    const href = hrefOf(add, 'new');
    if (!card) {
      void goHref(href, 'none');
      return;
    }
    growing.current = true;
    // 卡的位置、圆角由动画实现自己量（page-swap.ts 的 growFrom）
    // 长完（或被打断）收打字条和模糊层；新建页的临时层级由 growSwap 等打字条卸掉以后再还原，中间不露一帧被模糊层盖住的新建页
    const landed = (): void => {
      growing.current = false;
      setPlus(null);
    };
    void growSwap(() => void goHref(href, 'none'), card, landed);
  };
  const edit = (table: string, id: string): void => {
    const to = EDIT_OF[table];
    if (to) void navigate(to, id);
  };
  return (
    <>
      {/* 隐私记页、纪念日页：按住“＋”不录音（录下的会进普通随手记、日程） */}
      {bar ? <GlassBar active={tab} later={afterAppPainted} add={{ label: t('nav.add', {}), onClick: open, ...(hold ? { hold: plusHold } : {}) }} /> : null}
      <PlusSlot hold={hold} open={plus !== null} day={plus?.day ?? null} onExpand={expand} onEdit={edit} onOpen={open} onClose={() => setPlus(null)} />
    </>
  );
}

/** 提示条里“修改”某一条：表 → 编辑页路由（随手记、纪念日的编辑页还没有，先不跳） */
const EDIT_OF: Partial<Record<string, RouteName>> = { events: 'event', todos: 'todo' };

/** 功能开关关着的页面（hash 直接打开时）：不是出错 */
function FeatureOffView() {
  const t = useT();
  return (
    <main data-feature="off">
      <p role="status" data-testid="feature-off">
        {t('feature.off', {})}
      </p>
    </main>
  );
}

/** 顶部版本横幅（UpdateBanner.tsx）：还没启动（测试里）、本机库来自更新的版本（整屏提示管）时不画 */
function Banner() {
  const boot = getBoot();
  if (!boot) return null;
  return <BannerGate boot={boot} />;
}

// 横幅本体按需下载，首屏不带 UpdateBanner.tsx：订阅同一份状态，用 banner-kind.ts 判断有横幅要出了才下载、挂上，挂上以后一直挂着。
// 里面再包一层 Suspense：冷启动时外面那层照样把横幅和页面一起藏着；用着用着来了横幅，页面不跟着藏。分包取不到只是不画横幅
const LazyUpdateBanner = lazy(() => import('./UpdateBanner.tsx').then((m) => ({ default: m.UpdateBanner })));

function BannerGate({ boot }: { boot: Pick<BootResult, 'upgrade' | 'outbox'> }) {
  const state = useSyncExternalStore(boot.upgrade.subscribe, boot.upgrade.getState);
  const syncPaused = useUi((s) => s.banners.some((b) => b.kind === 'sync-paused'));
  const wanted = useRef(false);
  if (bannerKind(state, syncPaused) !== null) wanted.current = true;
  if (!wanted.current) return null;
  return (
    <Suspense fallback={null}>
      <LazyUpdateBanner upgrade={boot.upgrade} outbox={boot.outbox} onReload={reloadPage} />
    </Suspense>
  );
}

/** RemindHost 出错（渲染出错、分包加载失败）时记一条 js_error，code 只有“错误类型@文件名:行号” */
const logRemindError = (error: unknown): void => logEvent(JS_ERROR_ACT, { error });

/**
 * 提醒横幅和引擎：按 user_id 作 key，换账号重新挂载；页面路由传给它（'today' 不画顶部横幅，'remind' 都不画）。
 * 出错时自己的错误边界只吞掉提醒这一块，记一条 js_error；这次打开不再重试，下次打开 App 重新挂（接受的取舍）
 */
function Reminders({ route, ready }: { route: RouteName; ready: boolean }) {
  const userId = getBoot()?.userId ?? null;
  if (!userId) return null;
  return <RemindersFor key={userId} route={route} ready={ready} />;
}

/** 一个账号的提醒：since 在第一次渲染（App 打开、换账号）时记下；ready 之前不渲染 RemindHost，分包也不下载 */
function RemindersFor({ route, ready }: { route: RouteName; ready: boolean }) {
  const [since] = useState(() => clock.now());
  // 引擎出错了：记进 kit 的 remindDown，今天页照样挂“错过的提醒”、照旧全算。
  // 今天页等引擎 armed 才挂“错过的提醒”：分包一直下不来又不报错、本机库读不返回时会永远等下去，
  // 所以 ready 以后起看门狗，REMIND_ARM_WATCHDOG_MS 内还没 armed 也写 remindDown；之后 armed 了再清掉。卸载时清掉
  useEffect(() => {
    if (!ready) return;
    let fired = false;
    const id = remindArmWatchdog.start(() => {
      if (remindQueue.getState().armedSince === null) {
        fired = true;
        setRemindDown(true);
      }
    });
    const off = remindQueue.subscribe((s) => {
      if (s.armedSince === null) return;
      remindArmWatchdog.stop(id);
      if (fired) {
        fired = false;
        setRemindDown(false);
      }
    });
    return () => {
      remindArmWatchdog.stop(id);
      off();
    };
  }, [ready]);
  useEffect(() => () => setRemindDown(false), []);
  if (!ready) return null;
  return (
    <ErrorBoundary
      fallback={null}
      onError={(error) => {
        logRemindError(error);
        setRemindDown(true);
      }}
    >
      <Suspense fallback={null}>
        <RemindHost route={route} since={since} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** 提醒引擎挂上（ready）以后最多等多久 armed，过了算出错（remindDown） */
export const REMIND_ARM_WATCHDOG_MS = 15_000;
/** 看门狗的定时器：单独一个对象，测试 spy 它 */
export const remindArmWatchdog = {
  start: (fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, REMIND_ARM_WATCHDOG_MS),
  stop: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
};

/** 提醒最晚什么时候挂：从 App 第一次渲染算起，不管页面有没有画出来 */
export const REMIND_MAX_WAIT_MS = 5000;
/** 硬上限的定时器：单独一个对象，测试 spy 它（不去拦全局 setTimeout） */
export const remindMaxWait = {
  start: (fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, REMIND_MAX_WAIT_MS),
  stop: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
};

/**
 * 首屏画完（root-paint）、App 自己的页面显示着（告知页之后 root-paint 早已算画完，要等 App 自己的页）、浏览器空闲以后为真；
 * 页面一直不出来最晚 REMIND_MAX_WAIT_MS 也为真（比一直不响好）。now 为真当场为真；为真以后不再变回。依赖里没有路由：换页不重新计时
 */
function useAfterFirstPage(now: boolean): boolean {
  const [ready, setReady] = useState(now);
  useEffect(() => {
    if (ready) return;
    // afterAppPainted、whenIdle 没有取消：live 挡住卸载以后的回调
    let live = true;
    const go = (): void => void (live && setReady(true));
    const cap = remindMaxWait.start(go);
    let stopPage = (): void => undefined;
    afterAppPainted(() => {
      if (live) stopPage = whenMainShown(() => whenIdle(go));
    });
    return () => {
      live = false;
      remindMaxWait.stop(cap);
      stopPage();
    };
  }, [ready]);
  return ready;
}

const allRoutes: readonly FeatureRoute[] = [...featureRoutes, ...devRoutes];
// 切页过渡规则在 page-anim.ts，首屏画完以后由 TabBar 和横滑一起装上（router.ts 的 setAnimOf）

export function App() {
  const route = useRoute();
  // 冷启动就是整页提醒时立刻挂。挂上以后不再收回
  const remindReady = useAfterFirstPage(route.name === 'remind');
  // 冷启动：和提醒同一个时机后台先下载日历、待办、随手记三页；不另起一套判断
  const preloaded = useRef(false);
  useEffect(() => {
    if (!remindReady || preloaded.current) return;
    preloaded.current = true;
    void preloadPages(rlog, () => performance.now(), () => preloadGap());
  }, [remindReady]);
  const all = allRoutes;
  const found = all.find((r) => r.name === route.name);
  // samePageAs：#/calendar 和 #/cal/... 是同一个页面，错误边界用同一个 key，互相跳时不重新挂载、焦点留在按钮上
  const hit = (found?.samePageAs !== undefined && all.find((r) => r.name === found.samePageAs)) || found;
  const Page = hit?.Page;
  const pageKey = hit?.name ?? route.name;
  // 版本横幅和页面放在同一个 Suspense 里：页面分包没到时一起不画，启动画面不会因为先画出横幅就提前收起（root.tsx 头注释）。
  // 提醒在这个 Suspense 外面：等首屏画完才挂，不抢在页面前面画；切到分包没到的页时也不跟着藏
  // 横幅在页面的错误边界外面：页面出错时横幅还在；横幅自己出错只是不画横幅
  return (
    <>
      <Suspense fallback={<PagePending />}>
        <ErrorBoundary fallback={null}>
          <Banner />
        </ErrorBoundary>
        <ErrorBoundary key={pageKey} fallback={<ErrorView />}>
          {Page ? <Page /> : offRoutes.has(route.name) ? <FeatureOffView /> : <ErrorView />}
        </ErrorBoundary>
      </Suspense>
      {/* 底栏不和页面同一个 Suspense：出错只是不画底栏 */}
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <TabBar route={route.name} sub={route.params[0] ?? ''} />
        </Suspense>
      </ErrorBoundary>
      <Reminders route={route.name} ready={remindReady} />
    </>
  );
}
