// 启动时画什么（从 main.tsx 拆出来，好单独测）：
// • version_too_new：整屏提示，懒加载失败回退到静态提示。要先注册 SW 再渲染：“去更新”靠 SW，没注册时会误报“更新失败”
// • 在线且没看过要求的隐私说明版本：先过告知页关口 ConsentGate；其余（含离线）直接画 App
// • 关口最多空白 GATE_LIMIT_MS（含分包加载）：没挂上时由这里到点放行，挂上（onStart）以后由关口自己计。启动画面盖住空白但不封顶
// • 启动画面的收起：#root 里的只靠 main.tsx 经 first-paint.ts 的 whenContent（页面懒加载，分包没到时 #root 是空的）；
//   只有另挂在 body 下的“库被挡住”整屏提示旁边放 SplashRelease
// • 错误边界只包关口：关口出错 → 放行画 App；App 画在边界外，自己出错不会被当成关口失败再画一遍
import { Suspense, useCallback, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BootResult } from '../core/boot.ts';
import { seenNotice } from '../core/notice-seen.ts';
import { withTimeout } from '../platform/exit-basics.ts';
import type { UpgradeCenter } from '../core/upgrade.ts';
import { CacheBlockedScreen } from './CacheBlockedScreen.tsx';
import { ConsentGate } from '../features/onboarding/index.ts';
import { App } from './App.tsx';
import { AppCrashFallback } from './AppCrashFallback.tsx';
import { CacheTooNewFallback } from './CacheTooNewFallback.tsx';
import type { CacheTooNewScreen as TooNewScreen } from './CacheTooNewScreen.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { nextFrame } from '../motion/index.ts';
import { whenContent } from './first-paint.ts';
import { GATE_LIMIT_MS, msLeft } from '../platform/gate-limit.ts';
import { hideSplash } from '../platform/splash.ts';
import { SW_REGISTER_WAIT_MS } from '../platform/sw-register.ts';

/** 画在“库被挡住”整屏提示（不在 #root 里）旁边：提交以后的下一帧收起启动画面（重复调用无害） */
export function SplashRelease(): null {
  useEffect(() => nextFrame(() => void hideSplash()), []);
  return null;
}

// GATE_LIMIT_MS、msLeft 在 platform/gate-limit.ts，关口用同一份；main.tsx 经这里取
export { GATE_LIMIT_MS };

/** 在线时：先关口，放行后画 App。limitMs 测试用 */
export function GatedApp({ limitMs = GATE_LIMIT_MS }: { limitMs?: number } = {}): ReactElement {
  const [passed, setPassed] = useState(false);
  const [startedAt] = useState(() => Date.now());
  /** 关口已经挂上：之后的计时归关口 */
  const [gateUp, setGateUp] = useState(false);
  const pass = useCallback(() => setPassed(true), []);
  const onStart = useCallback(() => setGateUp(true), []);
  useEffect(() => {
    if (passed || gateUp) return undefined;
    // 关口分包还没加载好：到点放行（分包晚到也不再画关口，下次打开再问）
    const timer = setTimeout(pass, msLeft(limitMs, startedAt));
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

/** main.tsx 渲染的根外面那一层：没接住的渲染错误都换成静态的“哎呀，卡住了 · 刷新一下” */
export function withCrashFallback(root: ReactElement, onRefresh: () => void): ReactElement {
  return <ErrorBoundary fallback={<AppCrashFallback onRefresh={onRefresh} />}>{root}</ErrorBoundary>;
}

export interface RootDeps {
  online: boolean;
  onRefresh: () => void;
  /** version_too_new 时渲染前最多等它 SW_REGISTER_WAIT_MS；开发版不注册时不传 */
  registerSw?: () => Promise<unknown>;
  /** 测试用 */
  loadTooNew?: () => Promise<{ CacheTooNewScreen: typeof TooNewScreen }>;
}

/** 按 boot 的状态选要渲染的根；不抛错 */
export async function startRoot(boot: Pick<BootResult, 'status' | 'upgrade' | 'profile' | 'config'>, d: RootDeps): Promise<ReactElement> {
  // 本机缓存说明看过要求的隐私说明版本：不走关口、不等服务器（等这一问会让冷启动白屏一会儿）
  if (boot.status !== 'version_too_new') return d.online && !seenNotice(boot.profile, boot.config) ? <GatedApp /> : <App />;
  if (d.registerSw) await withTimeout<unknown>(d.registerSw, SW_REGISTER_WAIT_MS, () => undefined);
  const fallback = <CacheTooNewFallback onRefresh={d.onRefresh} />;
  try {
    const { CacheTooNewScreen } = await (d.loadTooNew ?? (() => import('./CacheTooNewScreen.tsx')))();
    return (
      <ErrorBoundary fallback={fallback}>
        <CacheTooNewScreen upgrade={boot.upgrade} onRefresh={d.onRefresh} />
      </ErrorBoundary>
    );
  } catch {
    return fallback;
  }
}

/** blocked 解除后整屏提示最多再留多久（#root 一直没画出东西时，例如换账号、回登录页，不能一直盖着） */
export const BLOCKED_RELEASE_MAX_MS = 5000;

export interface WatchBlockedOptions {
  doc?: Document;
  /** blocked 第一次变成 true、整屏提示画出来之前调一次（main.tsx 在这里先按“没有 profile”定界面语言） */
  onFirstBlocked?: () => void;
  frame?: (cb: () => void) => () => void;
  /** 测试用 */
  releaseMaxMs?: number;
}

/**
 * 升级本机库被别的标签页挡住时整屏提示。#root 这时还没 createRoot，所以另挂容器 #lemo-blocked 和它自己的根。
 * blocked 解除后不马上卸（会空白一小段）：等 #root 画出东西的下一帧再卸，最多等 BLOCKED_RELEASE_MAX_MS。返回取消订阅（同时马上卸掉）
 */
export function watchCacheBlocked(upgrade: UpgradeCenter, opts: WatchBlockedOptions = {}): () => void {
  const doc = opts.doc ?? document;
  const frame = opts.frame ?? nextFrame;
  const maxMs = opts.releaseMaxMs ?? BLOCKED_RELEASE_MAX_MS;
  let host: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let firstSeen = false;
  /** 正在等 #root 画出东西：取消等待 */
  let cancelRelease: (() => void) | null = null;
  const stopWaiting = (): void => {
    cancelRelease?.();
    cancelRelease = null;
  };
  const unmount = (): void => {
    stopWaiting();
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  };
  const releaseWhenPainted = (): void => {
    if (cancelRelease) return;
    let cancelFrame: (() => void) | null = null;
    let stopWait = (): void => undefined;
    // 先登记取消：#root 已有内容、帧又是同步的时候，下面当场就会 unmount
    cancelRelease = () => {
      stopWait();
      cancelFrame?.();
    };
    // 没有 #root（测试）时看 body
    stopWait = whenContent(doc.getElementById('root') ?? doc.body, (ok) => {
      if (ok) cancelFrame = frame(unmount);
      else unmount();
    }, maxMs);
  };
  const sync = (): void => {
    const blocked = upgrade.getState().blocked;
    if (blocked) {
      stopWaiting();
      if (root) return;
      if (!firstSeen) {
        firstSeen = true;
        opts.onFirstBlocked?.();
      }
      host = doc.createElement('div');
      host.id = 'lemo-blocked';
      doc.body.appendChild(host);
      root = createRoot(host);
      root.render(
        <>
          <CacheBlockedScreen />
          <SplashRelease />
        </>,
      );
    } else if (root) {
      releaseWhenPainted();
    }
  };
  const off = upgrade.subscribe(sync);
  sync();
  return () => {
    off();
    unmount();
  };
}
