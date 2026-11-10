// App 里的底栏（B2 FA-7）：第一个页面出现以前不画（冷启动和页面一起出，设计动效评审 D1）；
// 键盘弹起时底栏、“＋”、模糊带都藏起来（第 3 项；键盘检测 platform/viewport.ts 首屏画完以后才下载）
import { act, cleanup, render, screen } from '@testing-library/react';
import { lazy, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';

const upgrade = createUpgradeCenter({
  appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(() => Promise.resolve('no_update' as const)), attempt: { get: () => null, set: () => undefined },
});
let loadPage: () => Promise<{ default: ComponentType }> = () => Promise.resolve({ default: () => <main data-feature="today">今天</main> });
vi.mock('../../core/boot.ts', () => ({ getBoot: () => ({ upgrade, outbox: null }) }));
vi.mock('../features.ts', () => ({
  featureRoutes: [{ name: 'today', Page: lazy(() => loadPage()) }],
  offRoutes: new Set(),
}));
const kb = vi.hoisted(() => ({ fn: null as ((open: boolean, h: number) => void) | null, stops: 0 }));
vi.mock('../../platform/viewport.ts', () => ({
  watchKeyboard: (fn: (open: boolean, h: number) => void) => {
    kb.fn = fn;
    return () => (kb.stops += 1);
  },
}));

// 底栏首屏后部分（GlassBarFx）里的副本引擎：这里只看 data-kb，不跑真的（jsdom 没有 IntersectionObserver）
vi.mock('../../motion/glass-ghost.ts', () => ({ startGlass: () => ({ stop: () => undefined, poke: () => undefined }), playGel: () => true, forgetTilt: () => undefined }));

beforeEach(() => {
  window.location.hash = '#/today';
  kb.fn = null;
  kb.stops = 0;
});
afterEach(cleanup);

describe('App 里的底栏', () => {
  it('页面分包没到：不画底栏；页面出来了才画', async () => {
    let resolve: (m: { default: ComponentType }) => void = () => undefined;
    loadPage = () => new Promise((r) => (resolve = r));
    const { App } = await import('../App.tsx');
    render(<App />);
    expect(screen.queryByTestId('tabbar')).toBeNull();
    await act(async () => resolve({ default: () => <main data-feature="today">今天</main> }));
    expect(await screen.findByTestId('tabbar')).toBeTruthy();
  });

  it('键盘弹起：底栏、“＋”、模糊带带 data-kb="1"（藏起来）；收起还原；卸载时停止订阅', async () => {
    loadPage = () => Promise.resolve({ default: () => <main data-feature="today">今天</main> });
    const { App } = await import('../App.tsx');
    const view = render(<App />);
    const nav = await screen.findByTestId('tabbar');
    await vi.waitFor(() => expect(kb.fn).not.toBeNull());
    act(() => kb.fn?.(true, 300));
    const band = await screen.findByTestId('tabbar-band'); // 模糊带在首屏后部分里（主持人 11-05 首屏 ③）
    for (const el of [nav, screen.getByTestId('tabbar-add'), band]) expect(el.dataset['kb']).toBe('1');
    act(() => kb.fn?.(false, 0));
    for (const el of [nav, screen.getByTestId('tabbar-add'), band]) expect(el.dataset['kb']).toBeUndefined();
    view.unmount();
    expect(kb.stops).toBe(1);
  });
});
