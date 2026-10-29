// 启动时画什么（从 main.tsx 拆出来，好单独测；接手清单 CONSENT-sugg ③⑥）：
// • version_too_new（TC-B1-49，K6-ver-new）：整屏提示“请更新 App”，懒加载；懒加载失败、整屏组件出错回退到静态提示（复审 S1、S2）。
//   要先注册 SW 再渲染（复审 S4）：“去更新”靠 SW，首次打开还没注册时会误报“更新失败”
// • 在线：先过告知页关口 ConsentGate（features/onboarding，CONSENT-wire ②），关口放行再画 App
// • 关口最多空白 GATE_LIMIT_MS（5 秒，CONSENT-sugg ①；10-29 负责人定 5 秒，R-250），从 GatedApp 挂上算起、含关口分包的加载时间（接手清单 K6-sugg3 ④）：
//   分包还没加载好、关口还没挂上时由这里到点放行；关口挂上（onStart）以后由关口按剩下的时间自己计（startedAt + limitMs），
//   已经显示了告知页就不再被这里的计时打断。这段空白由启动画面盖住（R-251、R-254，index.html 的 #lemo-splash）；
//   启动画面只是把空白换成画面，不封顶等待时间，封顶仍靠这里的计时
// • 启动画面的收起：告知页、App（关口放行后、离线时）都只靠 main.tsx 的 hideSplashWhenPainted(#root)——#root 里真画出东西的下一帧才收。
//   App 的页面是懒加载的（App.tsx 里 <Suspense fallback={null}>），分包没到时 App 什么都不画；SplashRelease 若放在 App 旁边，
//   会在页面到之前就提交、开始淡出，露出空白（R-251 要盖住的正是这段，复查必改）。
//   SplashRelease 只放在不懒加载、提交即有内容的整屏提示和崩溃兜底页旁边（兜底页出来时 #root 可能早已有内容，靠它收）；最晚 5 秒见 main.tsx
// • 离线：直接画 App（关口问不了服务器，读失败本来也放行）
// • 最外层（withCrashFallback，K6-sugg3 ⑥）：main.tsx 渲染的根整个包一层错误边界，App 顶层出错显示静态的“哎呀，卡住了 · 刷新”，不白屏
// • 错误边界只包关口（CONSENT-sugg ③）：关口的分包加载失败、关口出错 → 放行画 App；App 画在边界外面，App 自己出错不会被当成关口失败
//   再画一遍 App
import { Suspense, useCallback, useEffect, useState, type ReactElement } from 'react';
import type { BootResult } from '../core/boot.ts';
import { ConsentGate } from '../features/onboarding/index.ts';
import { App } from './App.tsx';
import { AppCrashFallback } from './AppCrashFallback.tsx';
import { CacheTooNewFallback } from './CacheTooNewFallback.tsx';
import type { CacheTooNewScreen as TooNewScreen } from './CacheTooNewScreen.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { nextFrame } from '../motion/index.ts';
import { hideSplash } from '../platform/splash.ts';

/** 画在整屏提示、崩溃兜底页旁边：它们提交以后的下一帧收起启动画面（重复调用无害）。不要放在 App 旁边：App 的页面懒加载，提交时可能还是空的 */
export function SplashRelease(): null {
  useEffect(() => nextFrame(() => void hideSplash()), []);
  return null;
}

/** 根旁边带上 SplashRelease */
function released(node: ReactElement): ReactElement {
  return (
    <>
      {node}
      <SplashRelease />
    </>
  );
}

/**
 * 告知页关口最多空白多久（CONSENT-sugg ①），从 GatedApp 挂上算起（K6-sugg3 ④）。
 * 和 features/onboarding 的 CONSENT_GATE_MS 一样（app 拿不到功能的 hooks，root.test.tsx 按源码文字核对两边一致）；启动时以这里为准，传给关口
 */
export const GATE_LIMIT_MS = 5000;

/** 在线时：先关口，放行后画 App。limitMs 测试用 */
export function GatedApp({ limitMs = GATE_LIMIT_MS }: { limitMs?: number } = {}): ReactElement {
  const [passed, setPassed] = useState(false);
  /** 计时起点：GatedApp 挂上的那一刻（关口分包的加载时间算在里面） */
  const [startedAt] = useState(() => Date.now());
  /** 关口已经挂上：之后的计时归关口 */
  const [gateUp, setGateUp] = useState(false);
  const pass = useCallback(() => setPassed(true), []);
  const onStart = useCallback(() => setGateUp(true), []);
  useEffect(() => {
    if (passed || gateUp) return undefined;
    // 关口分包还没加载好：到点放行（分包晚到也不再画关口，下次打开再问）
    const timer = setTimeout(pass, Math.max(0, limitMs - (Date.now() - startedAt)));
    return () => clearTimeout(timer);
  }, [passed, gateUp, limitMs, startedAt, pass]);
  if (passed) return <App />;
  return (
    <ErrorBoundary fallback={null} onError={pass}>
      <Suspense fallback={null}>
        <ConsentGate onPass={pass} onStart={onStart} startedAt={startedAt} limitMs={limitMs} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** main.tsx 渲染的根外面那一层（K6-sugg3 ⑥）：里面没接住的渲染错误都换成静态的“哎呀，卡住了 · 刷新一下” */
export function withCrashFallback(root: ReactElement, onRefresh: () => void): ReactElement {
  // 兜底页出来时也收起启动画面，不然会盖在出错页上面
  return <ErrorBoundary fallback={released(<AppCrashFallback onRefresh={onRefresh} />)}>{root}</ErrorBoundary>;
}

export interface RootDeps {
  /** 现在联网（browserLifecycle.isOnline()） */
  online: boolean;
  /** 整屏提示的“刷新” */
  onRefresh: () => void;
  /** 注册 SW（version_too_new 时渲染前要等它；开发版不注册时不传） */
  registerSw?: () => Promise<unknown>;
  /** 测试用：换掉整屏提示的懒加载 */
  loadTooNew?: () => Promise<{ CacheTooNewScreen: typeof TooNewScreen }>;
}

/** 按 boot 的状态选要渲染的根；不抛错 */
export async function startRoot(boot: Pick<BootResult, 'status' | 'upgrade'>, d: RootDeps): Promise<ReactElement> {
  if (boot.status !== 'version_too_new') return d.online ? <GatedApp /> : <App />;
  if (d.registerSw) await d.registerSw().catch(() => undefined);
  const fallback = released(<CacheTooNewFallback onRefresh={d.onRefresh} />);
  try {
    const { CacheTooNewScreen } = await (d.loadTooNew ?? (() => import('./CacheTooNewScreen.tsx')))();
    return (
      <ErrorBoundary fallback={fallback}>
        <CacheTooNewScreen upgrade={boot.upgrade} onRefresh={d.onRefresh} />
        <SplashRelease />
      </ErrorBoundary>
    );
  } catch {
    return fallback;
  }
}
