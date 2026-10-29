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
  /** 关口桩的行为：pass 当场放行；hang 一直不放行；throw 渲染出错；chunk 分包加载失败 */
  gate: 'pass' as 'pass' | 'hang' | 'throw' | 'chunk',
  gateMounted: 0,
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
  function Gate({ onPass }: { onPass: () => void }) {
    stubs.gateMounted += 1;
    if (stubs.gate === 'throw') throw new Error('gate_boom');
    useEffect(() => {
      if (stubs.gate === 'pass') onPass();
    }, [onPass]);
    return <p data-testid="the-gate">gate</p>;
  }
  // React.lazy 只加载一次、结果缓存：正常和分包失败各备一个，按桩的行为挑
  type GateModule = { default: ComponentType<{ onPass: () => void }> };
  const ok = lazy(async (): Promise<GateModule> => ({ default: Gate }));
  const chunk = lazy(async (): Promise<GateModule> => {
    throw new Error('Failed to fetch dynamically imported module');
  });
  return {
    ConsentGate: (p: { onPass: () => void }) => {
      const L = stubs.gate === 'chunk' ? chunk : ok;
      return <L {...p} />;
    },
  };
});

import { ErrorBoundary } from '../ErrorBoundary.tsx';
import { startRoot, type RootDeps } from '../root.tsx';

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
  Object.assign(stubs, { appRenders: 0, appThrows: false, gate: 'pass', gateMounted: 0 });
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
