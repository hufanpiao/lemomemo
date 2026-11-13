// App 外壳：按 hash 路由挂页面（各页面懒加载，A27）
// • 提醒（B2 FA-4，REMIND-wiring）：RemindHost 挂一份（横幅、按钮条、提醒引擎），在页面的 Suspense 和错误边界外面、自己一个 Suspense，
//   提醒的分包没到、出错都不影响页面；key 用登录会话的 user_id（L8）：换账号就整个重新挂载，
//   引擎卸载时清掉模块级的“本次打开响过的”“本次会话只在本机处理过的”，不把上个账号的带过来。没登录（测试里没启动）不挂
// • 首屏减重 ⑥：首屏画完以后、浏览器空闲时才挂 RemindHost（约 14 KB 提醒代码不在首屏路径上）；冷启动就是整页提醒（点系统通知进来）时立刻挂。
//   “首屏画完”和同步、supabase-js 用同一套判断：platform/root-paint.ts 的 afterAppPainted（REMIND-arm-firstpaint，原来 App 自己放在
//   页面 Suspense 里的 ArmReminders 去掉了）。root-paint 的“画完”= 第一个页面 <main> 出现再过一帧；它自己的兜底
//   （render 后 startAppPaintLimit、挂上起 15 秒长兜底）到了也算画完。入口没挂 watchRoot 时（测试、别的入口）当场算画完。
//   since（从哪一刻起到点的进横幅）在 App 第一次渲染时记下，打开到挂上之间到点的照样响，只是晚响这一会儿：
//   首屏画完 + whenIdle（requestIdleCallback 最多 2 秒，没有时 300 ms）+ 下载 RemindHost 分包；后台标签页的定时器还会被节流。
//   提醒自己的硬上限 REMIND_MAX_WAIT_MS 保留（5 秒，从 App 第一次渲染算起，和 root-paint 的兜底谁先到算谁）：比 root-paint 告知页关口那段
//   （render 后 5 + 1 秒）更早，页面一直不出来（分包挂着、整屏提示）也最晚这时挂上
//   （这时页面可能还是空白，到点的横幅会先画出来、启动画面随之收起；比一直不响好，接线审查⑥ L3 接受的取舍）
// • 告知页之后（REMIND-arm-low L1）：告知页 ConsentPage 的根也是 <main>，用户点完同意 App 才第一次渲染，这时 root-paint 早已算画完。
//   做法二选一里选了“只认 App 挂上以后出现的功能页”：App 第一次渲染时 root-paint 已经算画完（告知页之后；入口没挂 watchRoot；
//   冷启动慢过 15 秒长兜底），就另外等 App 自己的页面 <main> 出现，再等空闲。理由：只写注释的话，提醒分包会和今天页分包抢下载，
//   今天页还没画出来时到点的按钮条可能先出现在空白屏上（启动画面早已收起）；改在 App 里等 root-paint 的 whenPage，不动首屏判断和告知页，
//   同步、supabase-js 的时机不变。页面一直不出来照样有 5 秒硬上限
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getBoot, type BootResult } from '../core/boot.ts';
import { RemindHost } from '../features/reminders/index.ts';
import { GlassBar } from '../kit/components/GlassBar/GlassBar.tsx';
import { useKeys } from '../kit/hooks/useKeys.ts';
import { useT } from '../kit/hooks/useT.ts';
import { useUi } from '../kit/state/ui-store.ts';
import { remindQueue, setRemindDown } from '../kit/state/remind-queue.ts';
import { clock } from '../platform/clock.ts';
import { JS_ERROR_ACT } from '../platform/env.ts';
import { logEvent } from '../../shared/core/log-bus.ts';
import { afterAppPainted, isAppPainted, pageShown, whenPage } from '../platform/root-paint.ts';
import { whenIdle } from '../platform/session.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { bannerKind } from './banner-kind.ts';
import { featureRoutes, offRoutes, type FeatureRoute } from './features.ts';
import { navigate, setSamePage, setTabSwitch, useRoute, type RouteName } from './router.ts';
import { tabBarFor } from './tab-of.ts';
import { PlusSlot, plusHold, preloadPlus } from './plus-slot.tsx';
import type { DateStr } from '../../shared/core/date.ts';
import { notesInput, setNewItemDay, setNewItemTitle, takeNewItemDay } from '../kit/state/new-item.ts';

// CSP 试验页（B0 第一项验证）：只在非正式版里挂。用构建期常量 import.meta.env.MODE（构建时替换成字面量），
// 正式构建时 rollup 把试验页整块删掉（运行时的 isProduction 删不掉，块会留在正式产物里）；build/check_no_probe.mjs 断言正式产物里没有它
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
 * 底栏（B2 FA-7）：显示在哪些页、选中哪个、“＋”新建什么见 tab-of.ts。
 * 在页面的 Suspense 外面（设计动效评审 D1）：切到分包没到的页时页面被藏起来，底栏不跟着藏、液滴照样滑。
 * 冷启动和页面一起出：第一个页面（main）出现以前不画，出现以后就一直画（不靠和页面共用 Suspense）
 */
function TabBar({ route }: { route: RouteName }) {
  const t = useT();
  const [paged, setPaged] = useState(pageShown);
  useEffect(() => (paged ? undefined : whenPage(() => setPaged(true))), [paged]);
  // 视口监听（platform/viewport.ts，不在首屏，首屏画完以后再下载）：写根节点的 --kb、data-kbo、--vh-gap、data-kbhide，
  // 键盘弹着时底栏和“＋”按 data-kbhide 由样式藏起（FA-7 第 3 项）；同一个分包里顺带拦 iOS 整页双指缩放
  useEffect(() => {
    let stop = (): void => undefined;
    let off = false;
    afterAppPainted(() => {
      import('../platform/viewport.ts')
        .then((m) => {
          if (off) return;
          const k = m.startViewport();
          const z = m.blockPageZoom();
          stop = () => {
            k();
            z();
          };
        })
        .catch(() => undefined);
    });
    return () => {
      off = true;
      stop();
    };
  }, []);
  // “＋”点一下打开打字条（B3 M4、FA-2）：打字条首屏画完以后先下载好（plus-slot.tsx）；open 时记着日历页选中的那天（R-353）
  // n：第几次点“＋”（Q-10：点空白收起了打字条、只留“已记下”提示条时，再点“＋”靠它把打字条重新画出来）
  const [plus, setPlus] = useState<{ day: DateStr | null; n: number } | null>(null);
  const opens = useRef(0);
  useEffect(() => afterAppPainted(() => void preloadPlus()), []);
  // 换页就收起（去改某一条、展开编辑也是换页）
  useEffect(() => setPlus(null), [route]);
  const bar = tabBarFor(route);
  // 日历页在捕获阶段记下了选中的那天（calendar/hooks/new-date.ts），这里取走；别的页也取走（清掉旧的）
  const open = (): void => {
    // 随手记页（R-380，线框“低 1”）：“＋”直接把光标放进页面底部的输入行，不开打字条（随手记页登记的原地聚焦，台账 Q-8）
    if (bar?.add === 'note') {
      notesInput.focus?.();
      return;
    }
    const day = takeNewItemDay();
    opens.current += 1;
    setPlus({ day: bar?.tab === 'calendar' ? day : null, n: opens.current });
  };
  // Ctrl+N 打字记一条（S24）：有“＋”的页才接；开着时再按只让 opened 加 1（收起的会重新展开、聚焦）
  useKeys({
    'mod+n': () => {
      if (!bar || !paged || bar.add === null) return false;
      open(); // 收起（只剩提示条）时 plus 不为 null，也要靠 opened 加 1 重新展开（独立验证 11-11）
      return true;
    },
  });
  if (!bar || !paged) return null;
  const { tab, add } = bar;
  if (add === null) return <GlassBar active={tab} later={afterAppPainted} />;
  // 展开成完整新建页：打的字和那天带过去（kit/state/new-item.ts，新建页挂上以后取走）
  const expand = (text: string, day: DateStr | null): void => {
    setNewItemTitle(text);
    setNewItemDay(day);
    setPlus(null);
    void navigate(add, 'new');
  };
  const edit = (table: string, id: string): void => {
    const to = EDIT_OF[table];
    if (to) void navigate(to, id);
  };
  return (
    <>
      {/* 隐私记页（B5 D14）：按住“＋”不录音（录下的会进普通随手记），点一下只打开隐私记的新建页 */}
      <GlassBar active={tab} later={afterAppPainted} add={{ label: t('nav.add', {}), onClick: open, ...(route === 'vault' ? {} : { hold: plusHold }) }} />
      <PlusSlot open={plus !== null} day={plus?.day ?? null} opened={plus?.n} onExpand={expand} onEdit={edit} onOpen={open} onClose={() => setPlus(null)} />
    </>
  );
}

/** 提示条里“修改”某一条：表 → 编辑页路由（随手记、纪念日的编辑页还没有，先不跳） */
const EDIT_OF: Partial<Record<string, RouteName>> = { events: 'event', todos: 'todo' };

/** 功能开关关着的页面（hash 直接打开时）：不是出错（K6 审查 L11） */
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

// 横幅本体按需下载（11-05 首屏瘦身，主持人定第 4 项）：平时没有横幅，首屏不带 UpdateBanner.tsx。
// 这里订阅同一份状态（升级中心、ui-store 的 sync-paused），用 banner-kind.ts 判断有横幅要出了才下载、挂上本体；
// 挂上以后一直挂着（之后出、收、换哪一条都由本体管，不反复下载）。
// 里面再包一层 Suspense：冷启动时页面分包没到，外面那层照样把横幅和页面一起藏着（横幅不会先画出来、启动画面不提前收）；
// 用着用着来了横幅，只是横幅晚到一下，页面不跟着藏。分包取不到：外面的 ErrorBoundary 接住，只是不画横幅
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

/** RemindHost 出错（渲染出错、分包加载失败）时记一条 js_error（接线审查 R2），code 只有“错误类型@文件名:行号” */
const logRemindError = (error: unknown): void => logEvent(JS_ERROR_ACT, { error });

/**
 * 提醒横幅和引擎：按 user_id 作 key，换账号重新挂载（L8）；页面路由传给它（'today' 不画顶部横幅，'remind' 都不画）。
 * • 出错（接线审查 R2）：自己的错误边界只吞掉提醒这一块，页面照常；记一条 js_error（logRemindError）。
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
  // 引擎出错了（这次打开不再重试）：记进 kit 的 remindDown，今天页照样挂“错过的提醒”、照旧全算（今天页待办 代码审查 M1）。
  // 今天页等引擎 armed 才挂“错过的提醒”（REMIND-shown-persist 修订 1 P2）：分包一直下不来又不报错（弱网、模块请求挂住）、本机库读不返回时
  // 会永远等下去，所以 ready 以后起看门狗，REMIND_ARM_WATCHDOG_MS 内还没 armed 也写 remindDown（审查“错过提醒推迟挂载”M1）；之后 armed 了再清掉。
  // 这一份卸载（换账号、退出）时清掉
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

/** 提醒引擎挂上（ready）以后最多等多久 armed，过了算出错（remindDown；审查“错过提醒推迟挂载”M1） */
export const REMIND_ARM_WATCHDOG_MS = 15_000;
/** 看门狗的定时器：单独一个对象，测试 spy 它 */
export const remindArmWatchdog = {
  start: (fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, REMIND_ARM_WATCHDOG_MS),
  stop: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
};

/** 提醒最晚什么时候挂：从 App 第一次渲染算起，不管页面有没有画出来（接线审查⑥ L3） */
export const REMIND_MAX_WAIT_MS = 5000;
/** 硬上限的定时器：单独一个对象，测试 spy 它（不去拦全局 setTimeout，接线审查⑥ N2） */
export const remindMaxWait = {
  start: (fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, REMIND_MAX_WAIT_MS),
  stop: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
};

const allRoutes: readonly FeatureRoute[] = [...featureRoutes, ...devRoutes];
/** 页面归属：samePageAs 指向的那条，没写就是自己 */
const pageOf = (name: RouteName): RouteName => allRoutes.find((r) => r.name === name)?.samePageAs ?? name;
// 登记了 samePageAs 的页面组（目前只有月历：calendar + cal）；只有这些页在页内前进 / 后退时不起整页动画。
// 别的同名路由（#/event/1 → #/event/2）照旧是换页，不算（router.ts setSamePage，代码复审 R2）
const grouped = new Set(allRoutes.flatMap((r) => (r.samePageAs === undefined ? [] : [r.samePageAs])));
setSamePage((a, b) => grouped.has(pageOf(a.name)) && pageOf(a.name) === pageOf(b.name));
// 四个页签之间互切（两头都有底栏、页签不同）：不起 View Transition，新页淡入，底栏一直实时模糊（router.ts setTabSwitch；负责人 11-06 方案 B）
setTabSwitch((a, b) => {
  const x = tabBarFor(a.name);
  const y = tabBarFor(b.name);
  return x !== null && y !== null && x.tab !== y.tab;
});

export function App() {
  const route = useRoute();
  // 提醒什么时候挂（首屏减重 ⑥）：冷启动就是整页提醒时立刻挂；否则等首屏画完（root-paint）、浏览器空闲。挂上以后不再收回
  const [remindReady, setRemindReady] = useState(() => route.name === 'remind');
  const [armRemind] = useState(() => () => setRemindReady(true));
  // App 第一次渲染时 root-paint 已经算画完（告知页之后等，见头注释 L1）：还要等 App 自己的功能页出现
  const [needOwnPage] = useState(isAppPainted);
  // 硬上限：页面一直不提交（分包挂着不成功也不失败）也最晚 REMIND_MAX_WAIT_MS 挂上
  useEffect(() => {
    if (remindReady) return;
    // 依赖里没有路由：换页不重新计时（接线审查⑥ N1）
    const t = remindMaxWait.start(armRemind);
    return () => remindMaxWait.stop(t);
  }, [remindReady, armRemind]);
  // 首屏画完再等空闲（REMIND-arm-firstpaint）：afterAppPainted、whenIdle 都没有取消，用 cancelled 挡住卸载、已经挂上以后的回调
  // （REMIND-arm-low L3 有测试守着）；等 App 自己的功能页那一段（L1）可以取消，卸载时一起停掉
  useEffect(() => {
    if (remindReady) return;
    let cancelled = false;
    let stopOwn = (): void => undefined;
    afterAppPainted(() => {
      if (cancelled) return;
      const idle = (): void => whenIdle(() => {
        if (!cancelled) armRemind();
      });
      if (needOwnPage) stopOwn = whenPage(idle);
      else idle();
    });
    return () => {
      cancelled = true;
      stopOwn();
    };
  }, [remindReady, armRemind, needOwnPage]);
  const all = allRoutes;
  const found = all.find((r) => r.name === route.name);
  // samePageAs：#/calendar 和 #/cal/... 是同一个页面，挂同一个组件、错误边界用同一个 key，
  // 互相跳（月历点“下个月”）时不重新挂载，焦点留在按钮上（B2 FA-3 代码审查 M7）
  const hit = (found?.samePageAs !== undefined && all.find((r) => r.name === found.samePageAs)) || found;
  const Page = hit?.Page;
  const pageKey = hit?.name ?? route.name;
  // 版本横幅和页面放在同一个 Suspense 里：页面分包没到时一起不画，启动画面不会因为先画出横幅就提前收起（root.tsx 头注释）。
  // 提醒在这个 Suspense 外面（首屏减重 ⑥）：要等首屏画完、浏览器空闲才挂（冷启动整页提醒时那一页就是 remind 页面本身，横幅和按钮条都不画），
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
      </Suspense>
      {/* 底栏不和页面同一个 Suspense（D1）：自己一个错误边界、一个 Suspense；出错只是不画底栏 */}
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <TabBar route={route.name} />
        </Suspense>
      </ErrorBoundary>
      <Reminders route={route.name} ready={remindReady} />
    </>
  );
}
