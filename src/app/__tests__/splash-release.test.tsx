// 启动画面的收起接线（R-251、R-254；main.tsx 的 hideSplashAfter、经 root-paint.ts 的 whenContent 收起）：
// • 关口还在问（什么都不画）：启动画面继续盖着
// • 关口放行、离线画 App：App 的页面还在懒加载（Suspense fallback 为 null，#root 是空的）时不收，页面画出来以后才收（复查必改）
// • 崩溃兜底页 AppCrashFallback、整屏提示（version_too_new）画进 #root：也收起，不盖在上面
// • main.tsx 里确实接了 5 秒兜底和 #root 首次绘制
// 按 main.tsx 的做法挂：render 的容器当 #root，先 watchRoot + whenContent；App 换成“懒加载页面”的桩，nextFrame 换成立即执行
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  gate: 'pass' as 'pass' | 'hang',
  appThrows: false,
  /** 页面分包：每个用例换一个新的 Promise，测试自己决定什么时候到 */
  page: null as null | { promise: Promise<unknown>; resolve: () => void },
}));

vi.mock('../App.tsx', async () => {
  const { lazy, Suspense } = await import('react');
  function Page() {
    return <p data-testid="the-page">page</p>;
  }
  // 和真的 App 一样：页面懒加载，外面 <Suspense fallback={null}>。React.lazy 会缓存结果，每个分包（stubs.page）各建一个
  const byPage = new WeakMap<object, ReturnType<typeof lazy>>();
  const lazyFor = (page: { promise: Promise<unknown> }) => {
    let L = byPage.get(page);
    if (!L) {
      L = lazy(async () => {
        await page.promise;
        return { default: Page };
      });
      byPage.set(page, L);
    }
    return L;
  };
  return {
    App: () => {
      if (stubs.appThrows) throw new Error('app_boom');
      if (!stubs.page) throw new Error('先 newPage()');
      const Lazy = lazyFor(stubs.page);
      return (
        <Suspense fallback={null}>
          <Lazy />
        </Suspense>
      );
    },
  };
});

vi.mock('../../features/onboarding/index.ts', async () => {
  const { useEffect } = await import('react');
  function ConsentGate({ onPass }: { onPass: () => void }) {
    useEffect(() => {
      if (stubs.gate === 'pass') onPass();
    }, [onPass]);
    return null;
  }
  return { ConsentGate };
});

vi.mock('../../motion/index.ts', () => ({
  nextFrame: (cb: () => void) => {
    cb();
    return () => undefined;
  },
}));

import { GatedApp, startRoot, withCrashFallback } from '../root.tsx';
import { hideSplash, SPLASH_ID } from '../../platform/splash.ts';
import { resetRootPaintForTest, watchRoot, whenContent } from '../../platform/root-paint.ts';

const splash = () => document.getElementById(SPLASH_ID);
const leaving = () => splash()?.classList.contains('is-leaving') === true;
const now = (cb: () => void) => {
  cb();
  return () => undefined;
};

/** 照 main.tsx：#root 先挂 watchRoot、whenContent 收启动画面，再渲染 */
function mount(ui: React.ReactElement) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  watchRoot(root, now);
  whenContent(() => void now(() => void hideSplash()));
  return render(ui, { container: root });
}

function newPage() {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((r) => (resolve = r));
  stubs.page = { promise, resolve };
  return stubs.page;
}

beforeEach(() => {
  stubs.gate = 'pass';
  stubs.appThrows = false;
  const el = document.createElement('div');
  el.id = SPLASH_ID;
  document.body.appendChild(el);
});

afterEach(() => {
  cleanup();
  resetRootPaintForTest();
  document.body.replaceChildren();
});

describe('启动画面在真画出东西以后才收', () => {
  it('关口还在问：#root 是空的，不收', async () => {
    stubs.gate = 'hang';
    newPage().resolve();
    mount(<GatedApp limitMs={60_000} />);
    await act(async () => undefined);
    expect(leaving()).toBe(false);
  });

  it('关口放行、页面还在懒加载：不收；页面到了、画出来以后才收', async () => {
    const page = newPage();
    const { container } = mount(<GatedApp />);
    await act(async () => undefined);
    expect(container.childNodes).toHaveLength(0);
    expect(leaving()).toBe(false);
    await act(async () => page.resolve());
    await screen.findByTestId('the-page');
    expect(leaving()).toBe(true);
  });

  it('离线直接画 App、页面还在懒加载：同样不收，到了才收', async () => {
    const page = newPage();
    mount(await startRoot({ status: 'ok', upgrade: null } as never, { online: false, onRefresh: () => undefined }));
    await act(async () => undefined);
    expect(leaving()).toBe(false);
    await act(async () => page.resolve());
    await screen.findByTestId('the-page');
    expect(leaving()).toBe(true);
  });

  it('App 顶层出错，崩溃兜底页画进 #root：收起', async () => {
    stubs.appThrows = true;
    newPage();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mount(withCrashFallback(await startRoot({ status: 'ok', upgrade: null } as never, { online: false, onRefresh: () => undefined }), () => undefined));
    await screen.findByTestId('app-crash-fallback');
    expect(leaving()).toBe(true);
    err.mockRestore();
  });

  it('整屏提示（本机库来自更新的版本）画进 #root：收起', async () => {
    newPage();
    const root = await startRoot({ status: 'version_too_new', upgrade: null } as never, {
      online: true,
      onRefresh: () => undefined,
      loadTooNew: async () => ({ CacheTooNewScreen: () => <p data-testid="too-new">new</p> }),
    });
    mount(root);
    await screen.findByTestId('too-new');
    expect(leaving()).toBe(true);
  });
});

describe('main.tsx 的接线（按源码文字核对，main.tsx 一 import 就会启动整个 App）', () => {
  const main = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  it('模块顶层就排上 5 秒兜底（从启动起算）', () => {
    expect(main).toMatch(/^hideSplashAfter\(\);$/m);
    expect(main.indexOf('hideSplashAfter();')).toBeLessThan(main.indexOf('async function start('));
  });
  it('#root 第一次画出东西的下一帧收起：在 render 之前、watchRoot 之后挂上，用 motion 的 nextFrame', () => {
    const at = main.indexOf('whenContent(() => void nextFrame(() => void hideSplash()));');
    expect(at).toBeGreaterThan(main.indexOf('watchRoot(el, nextFrame);'));
    expect(at).toBeLessThan(main.indexOf('createRoot(el).render('));
  });
});
