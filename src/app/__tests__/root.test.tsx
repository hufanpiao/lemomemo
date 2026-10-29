// main.tsx 启动时选根的接线（src/app/root.tsx；接手清单 CONSENT-sugg ③⑥）：
// • 在线：先画告知页关口，放行后才画 App；离线：直接画 App，不碰关口
// • version_too_new：先注册 SW 再懒加载整屏提示；不画关口、不画 App；整屏提示分包加载失败 → 静态提示
// • 关口分包加载失败、关口渲染出错：放行画 App（错误边界只包关口）
// • App 自己出错：不被关口的错误边界接住再画一遍 App（CONSENT-sugg ③ 修之前 fallback 是 <App />，会再画一次）
// App、关口都换成桩：只测接线，关口本身见 features/onboarding/__tests__/consent-wiring.test.tsx
import { act, cleanup, render, screen } from '@testing-library/react';
import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  appRenders: 0,
  appThrows: false,
  /** 关口桩的行为：pass 当场放行；hang 一直不放行；throw 渲染出错；chunk 分包加载失败；slow 分包一直加载不完 */
  gate: 'pass' as 'pass' | 'hang' | 'throw' | 'chunk' | 'slow',
  gateMounted: 0,
  /** 关口收到的计时参数（K6-sugg3 ④） */
  gateProps: null as null | { startedAt?: number; limitMs?: number },
}));

vi.mock('../App.tsx', () => ({
  App: () => {
    stubs.appRenders += 1;
    if (stubs.appThrows) throw new Error('app_boom');
    return <p data-testid="the-app">app</p>;
  },
}));

vi.mock('../../features/onboarding/index.ts', async () => {
  const { useEffect } = await import('react');
  type GateProps = { onPass: () => void; onStart?: () => void; startedAt?: number; limitMs?: number };
  function Gate({ onPass, onStart, startedAt, limitMs }: GateProps) {
    stubs.gateMounted += 1;
    stubs.gateProps = { ...(startedAt === undefined ? {} : { startedAt }), ...(limitMs === undefined ? {} : { limitMs }) };
    if (stubs.gate === 'throw') throw new Error('gate_boom');
    useEffect(() => {
      onStart?.();
      if (stubs.gate === 'pass') onPass();
    }, [onPass, onStart]);
    return <p data-testid="the-gate">gate</p>;
  }
  // React.lazy 只加载一次、结果缓存：正常、分包失败、分包一直加载不完各备一个，按桩的行为挑
  type GateModule = { default: ComponentType<GateProps> };
  const ok = lazy(async (): Promise<GateModule> => ({ default: Gate }));
  const chunk = lazy(async (): Promise<GateModule> => {
    throw new Error('Failed to fetch dynamically imported module');
  });
  const slow = lazy((): Promise<GateModule> => new Promise<GateModule>(() => undefined));
  return {
    ConsentGate: (p: GateProps) => {
      const L = stubs.gate === 'chunk' ? chunk : stubs.gate === 'slow' ? slow : ok;
      return <L {...p} />;
    },
  };
});

import { ErrorBoundary } from '../ErrorBoundary.tsx';
import { readFileSync } from 'node:fs';
import { GATE_LIMIT_MS, GatedApp, startRoot, withCrashFallback, type RootDeps } from '../root.tsx';

const ready = { status: 'ready', upgrade: {} } as unknown as Parameters<typeof startRoot>[0];
const tooNew = { status: 'version_too_new', upgrade: {} } as unknown as Parameters<typeof startRoot>[0];

/** 测试外层的错误边界：接住 App 自己抛的错 */
class Outer extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p data-testid="outer-caught">caught</p> : this.props.children;
  }
}

async function show(el: ReactNode) {
  await act(async () => {
    render(<Outer>{el}</Outer>);
  });
}

beforeEach(() => {
  Object.assign(stubs, { appRenders: 0, appThrows: false, gate: 'pass', gateMounted: 0, gateProps: null });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);   // React 打印被接住的错误
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('启动选根（CONSENT-sugg ⑥：main.tsx 关口接线）', () => {
  it('在线：先画关口，放行后画 App', async () => {
    stubs.gate = 'hang';
    await show(await startRoot(ready, { online: true, onRefresh: vi.fn() }));
    expect(screen.getByTestId('the-gate')).toBeTruthy();
    expect(screen.queryByTestId('the-app')).toBeNull();
    cleanup();
    stubs.gate = 'pass';
    await show(await startRoot(ready, { online: true, onRefresh: vi.fn() }));
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('the-gate')).toBeNull();
  });

  it('离线：直接画 App，不加载关口', async () => {
    stubs.gate = 'hang';
    await show(await startRoot(ready, { online: false, onRefresh: vi.fn() }));
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(stubs.gateMounted).toBe(0);
  });

  it('version_too_new：先注册 SW 再懒加载整屏提示；不画关口、不画 App', async () => {
    const order: string[] = [];
    const registerSw = vi.fn(async () => void order.push('sw'));
    const loadTooNew = vi.fn(async () => {
      order.push('load');
      return { CacheTooNewScreen: () => <p data-testid="too-new">too new</p> } as unknown as Awaited<ReturnType<NonNullable<RootDeps['loadTooNew']>>>;
    });
    await show(await startRoot(tooNew, { online: true, onRefresh: vi.fn(), registerSw, loadTooNew }));
    expect(order).toEqual(['sw', 'load']);
    expect(screen.getByTestId('too-new')).toBeTruthy();
    expect(stubs.gateMounted).toBe(0);
    expect(stubs.appRenders).toBe(0);
  });

  it('version_too_new 且整屏提示分包加载失败、注册 SW 出错：回退到静态提示，不抛', async () => {
    const root = await startRoot(tooNew, {
      online: true, onRefresh: vi.fn(),
      registerSw: () => Promise.reject(new Error('sw')),
      loadTooNew: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    });
    await show(root);
    expect(screen.getByTestId('cache-too-new-fallback')).toBeTruthy();
    expect(stubs.appRenders).toBe(0);
  });

  it('关口分包加载失败：放行画 App（不白屏）', async () => {
    stubs.gate = 'chunk';
    await show(await startRoot(ready, { online: true, onRefresh: vi.fn() }));
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('关口渲染出错：放行画 App', async () => {
    stubs.gate = 'throw';
    await show(await startRoot(ready, { online: true, onRefresh: vi.fn() }));
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('App 自己出错（CONSENT-sugg ③）：关口的错误边界不接，App 不被再画一遍；错误交给外层', async () => {
    stubs.appThrows = true;
    const caught = vi.spyOn(ErrorBoundary.prototype, 'componentDidCatch');
    await show(await startRoot(ready, { online: true, onRefresh: vi.fn() }));
    expect(screen.getByTestId('outer-caught')).toBeTruthy();
    // App 不在关口的错误边界里：边界一次也没接到（修之前 App 在里面，边界接住后 fallback 又画一遍 App）
    expect(caught).not.toHaveBeenCalled();
    expect(stubs.gateMounted).toBe(1);
  });
});

describe('关口的上限（5 秒）从 GatedApp 挂上算起，含关口分包的加载时间（K6-sugg3 ④）', () => {
  afterEach(() => vi.useRealTimers());

  it('关口分包一直加载不完：到 GATE_LIMIT_MS 放行画 App，不再空白', async () => {
    vi.useFakeTimers();
    stubs.gate = 'slow';
    await show(<GatedApp />);
    expect(screen.queryByTestId('the-app')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(GATE_LIMIT_MS - 1);
    });
    expect(screen.queryByTestId('the-app')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(stubs.gateMounted).toBe(0);
  });

  it('关口挂上以后：计时归关口（这里不再到点放行，已显示的告知页不被打断）；关口收到的起点是 GatedApp 挂上的那一刻', async () => {
    vi.useFakeTimers();
    stubs.gate = 'hang';
    const t0 = Date.now();
    await show(<GatedApp />);
    expect(screen.getByTestId('the-gate')).toBeTruthy();
    expect(stubs.gateProps).toEqual({ startedAt: t0, limitMs: GATE_LIMIT_MS });
    await act(async () => {
      vi.advanceTimersByTime(GATE_LIMIT_MS * 3);
    });
    expect(screen.getByTestId('the-gate')).toBeTruthy();
    expect(screen.queryByTestId('the-app')).toBeNull();
  });

  it('GATE_LIMIT_MS 和 features/onboarding 的 CONSENT_GATE_MS 一样（app 拿不到功能的 hooks，按源码文字核对）', () => {
    const src = readFileSync('src/features/onboarding/hooks/useConsentWiring.ts', 'utf8');
    expect(/export const CONSENT_GATE_MS = (\d+);/.exec(src)?.[1]).toBe(String(GATE_LIMIT_MS));
  });
});

describe('最外层的静态兜底（K6-sugg3 ⑥）', () => {
  it('App 顶层出错：不白屏，显示“哎呀，卡住了 · 刷新一下”（不懒加载），焦点在“刷新”，点了重新载入', async () => {
    const { zh } = await import('../../../shared/i18n/zh.ts');
    stubs.appThrows = true;
    const onRefresh = vi.fn();
    await show(withCrashFallback(await startRoot(ready, { online: false, onRefresh }), onRefresh));
    const box = screen.getByTestId('app-crash-fallback');
    expect(box.textContent).toContain(zh['app.crashed.title']);
    const btn = screen.getByRole('button', { name: zh['app.crashed.refresh'] });
    expect(document.activeElement).toBe(btn);
    btn.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('outer-caught')).toBeNull();   // 自己接住了，没漏到外面
  });

  it('不出错时原样画里面的根', async () => {
    await show(withCrashFallback(await startRoot(ready, { online: false, onRefresh: vi.fn() }), vi.fn()));
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('app-crash-fallback')).toBeNull();
  });

  it('韩文：用公共词典的 ko（R-106 初稿）', async () => {
    const { ko } = await import('../../../shared/i18n/ko.ts');
    const { uiStore } = await import('../../kit/state/ui-store.ts');
    uiStore.getState().setLocale('ko-KR');
    try {
      stubs.appThrows = true;
      await show(withCrashFallback(await startRoot(ready, { online: false, onRefresh: vi.fn() }), vi.fn()));
      expect(screen.getByTestId('app-crash-fallback').textContent).toContain(ko['app.crashed.title']);
    } finally {
      uiStore.getState().setLocale('zh-CN');
    }
  });
});
