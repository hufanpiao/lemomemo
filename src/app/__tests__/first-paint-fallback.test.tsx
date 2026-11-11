// FIRSTPAINT-nofeature 的 App 部分（前端 B 11-04 把 ErrorView、FeatureOffView 的根改成 main[data-feature="error"] / main[data-feature="off"]）：
// 冷启动落在出错页、功能关掉页时，首屏判断（watchRoot）照常在页面出来后一帧算画完，不用等 15 秒长兜底
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { lazy, type ComponentType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';
import { afterAppPainted, APP_PAGE_SELECTOR, resetRootPaintForTest, watchRoot } from '../../platform/root-paint.ts';

vi.setConfig({ testTimeout: 15_000 });

const upgrade = createUpgradeCenter({
  appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(() => Promise.resolve('no_update' as const)), attempt: { get: () => null, set: () => undefined },
});
upgrade.setSwReady();

const state = vi.hoisted(() => ({ routes: [] as unknown[], off: new Set<string>() }));
vi.mock('../../core/boot.ts', () => ({ getBoot: () => ({ upgrade, outbox: null }) }));
vi.mock('../features.ts', () => ({
  get featureRoutes() {
    return state.routes;
  },
  get offRoutes() {
    return state.off;
  },
}));

function Boom(): never {
  throw new Error('page_boom');
}

afterEach(() => {
  cleanup();
  resetRootPaintForTest();
  for (const el of [...document.body.children]) el.remove();
  window.location.hash = '';
});

/** 挂上首屏判断（长兜底设得远远的，确认不是兜底触发的）再渲染 App，返回“下一帧”队列和是否已算画完 */
async function renderWatched(before?: () => Promise<void>): Promise<{ frames: (() => void)[]; painted: () => boolean; root: HTMLElement }> {
  const frames: (() => void)[] = [];
  let painted = false;
  const root = document.createElement('div');
  document.body.append(root);
  watchRoot(root, (fn) => {
    frames.push(fn);
    return () => undefined;
  }, 600_000);
  afterAppPainted(() => (painted = true));
  // App 的路由表（allRoutes）是模块加载时算好的：每条用例按自己的 state 重新载入一份 App
  vi.resetModules();
  // 要在 App 用的那一份模块上预置状态（例如 ui-store 的横幅）：resetModules 之后、载入 App 之前做
  await before?.();
  const { App } = await import('../App.tsx');
  render(<App />, { container: root });
  return { frames, painted: () => painted, root };
}

describe('出错页、功能关掉页也算画完（FIRSTPAINT-nofeature）', () => {
  it('ErrorView（页面出错）：根是 main[data-feature="error"]，出来后下一帧算画完', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.routes = [{ name: 'today', Page: lazy(() => Promise.resolve({ default: Boom as ComponentType })) }];
    state.off = new Set();
    const { frames, painted } = await renderWatched();
    const err = await screen.findByTestId('app-error', {}, { timeout: 10_000 });
    expect(err.closest(APP_PAGE_SELECTOR)?.getAttribute('data-feature')).toBe('error');
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(painted()).toBe(false);
    act(() => frames[0]?.());
    expect(painted()).toBe(true);
  });

  it('FeatureOffView（功能开关关着）：根是 main[data-feature="off"]，出来后下一帧算画完', async () => {
    state.routes = [];
    state.off = new Set(['today']);
    const { frames, painted } = await renderWatched();
    const off = await screen.findByTestId('feature-off', {}, { timeout: 10_000 });
    expect(off.closest(APP_PAGE_SELECTOR)?.getAttribute('data-feature')).toBe('off');
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(painted()).toBe(false);
    act(() => frames[0]?.());
    expect(painted()).toBe(true);
  });
});

// 首屏判断放宽与推送认领核对审查 L4：外壳状态（顶部横幅亮着）下也没有常驻 main，不会在页面分包到之前就“画完”。
// 提醒（RemindHost 和按钮条）的运行时状态这里不渲染：它要真的数据层（集合、提醒计算、push-status），在这里搭替身测的是替身不是外壳；
// 提醒那几个文件里一个 main 都不许有，由 first-paint-pages.test.tsx 的源码白名单守着（PAGE_FILES 以外的文件出现 main 就挂）
describe('外壳状态：顶部横幅亮着（同步暂停 + 有新版本）', () => {
  it('页面分包没到：一个 main 都没有，首屏判断不触发；到了以后只有页面自己那一个，横幅也在', async () => {
    let release!: (m: { default: ComponentType }) => void;
    const Today = (): ReactElement => <main data-feature="today">今天</main>;
    state.routes = [{ name: 'today', Page: lazy(() => new Promise<{ default: ComponentType }>((r) => (release = r))) }];
    state.off = new Set();
    const { frames, root } = await renderWatched(async () => {
      const { uiStore } = await import('../../kit/state/ui-store.ts');
      uiStore.getState().pushBanner({ id: 'after-paint-failed', kind: 'sync-paused' });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // 前半段只确认首屏判断没被提前触发：横幅和页面在同一个 Suspense 里，分包没到时横幅也不在，这一段测不到横幅里有没有 main
    // （首屏判断放宽与推送认领核对复审 新 L3）。横幅里有没有 main 靠后半段“到了以后只有页面自己那一个”拦
    expect(root.querySelectorAll(APP_PAGE_SELECTOR)).toHaveLength(0);
    expect(frames).toHaveLength(0);
    await act(async () => release({ default: Today }));
    await screen.findByTestId('update-banner', {}, { timeout: 10_000 });
    expect(root.querySelectorAll(APP_PAGE_SELECTOR)).toHaveLength(1);
    expect(root.querySelector(APP_PAGE_SELECTOR)?.getAttribute('data-feature')).toBe('today');
    await waitFor(() => expect(frames).toHaveLength(1));
  });
});
