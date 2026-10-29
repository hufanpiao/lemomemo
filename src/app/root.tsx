// 启动时画什么（从 main.tsx 拆出来，好单独测；接手清单 CONSENT-sugg ③⑥）：
// • version_too_new（TC-B1-49，K6-ver-new）：整屏提示“请更新 App”，懒加载；懒加载失败、整屏组件出错回退到静态提示（复审 S1、S2）。
//   要先注册 SW 再渲染（复审 S4）：“去更新”靠 SW，首次打开还没注册时会误报“更新失败”
// • 在线：先过告知页关口 ConsentGate（features/onboarding，CONSENT-wire ②），关口放行再画 App
// • 离线：直接画 App（关口问不了服务器，读失败本来也放行）
// • 错误边界只包关口（CONSENT-sugg ③）：关口的分包加载失败、关口出错 → 放行画 App；App 画在边界外面，App 自己出错不会被当成关口失败
//   再画一遍 App
import { Suspense, useCallback, useState, type ReactElement } from 'react';
import type { BootResult } from '../core/boot.ts';
import { ConsentGate } from '../features/onboarding/index.ts';
import { App } from './App.tsx';
import { CacheTooNewFallback } from './CacheTooNewFallback.tsx';
import type { CacheTooNewScreen as TooNewScreen } from './CacheTooNewScreen.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/** 在线时：先关口，放行后画 App */
export function GatedApp(): ReactElement {
  const [passed, setPassed] = useState(false);
  const pass = useCallback(() => setPassed(true), []);
  if (passed) return <App />;
  return (
    <ErrorBoundary fallback={null} onError={pass}>
      <Suspense fallback={null}>
        <ConsentGate onPass={pass} />
      </Suspense>
    </ErrorBoundary>
  );
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
