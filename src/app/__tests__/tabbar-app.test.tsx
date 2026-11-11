// App 里的底栏（B2 FA-7）：第一个页面出现以前不画（冷启动和页面一起出，设计动效评审 D1）；
// 首屏画完以后才下载 platform/viewport.ts、开始盯视口（键盘弹着时由它写根节点 data-kbhide，底栏样式按它藏，第 3 项）
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
const kb = vi.hoisted(() => ({ starts: 0, stops: 0, zoom: 0, zoomStops: 0 }));
vi.mock('../../platform/viewport.ts', () => ({
  startViewport: () => {
    kb.starts += 1;
    return () => (kb.stops += 1);
  },
  blockPageZoom: () => {
    kb.zoom += 1;
    return () => (kb.zoomStops += 1);
  },
}));

// 底栏首屏后部分（GlassBarFx）里的副本引擎：这里不跑真的（jsdom 没有 IntersectionObserver）
vi.mock('../../motion/glass-ghost.ts', () => ({ startGlass: () => ({ stop: () => undefined, poke: () => undefined }), playGel: () => true, forgetTilt: () => undefined }));

beforeEach(() => {
  window.location.hash = '#/today';
  kb.starts = 0;
  kb.stops = 0;
  kb.zoom = 0;
  kb.zoomStops = 0;
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

  it('首屏画完以后开始盯视口（只开一次）；底栏、“＋”、模糊带不带键盘属性（只看根节点 data-kbhide）；卸载时停止', async () => {
    loadPage = () => Promise.resolve({ default: () => <main data-feature="today">今天</main> });
    const { App } = await import('../App.tsx');
    const view = render(<App />);
    const nav = await screen.findByTestId('tabbar');
    await vi.waitFor(() => expect(kb.starts).toBe(1));
    const band = await screen.findByTestId('tabbar-band'); // 模糊带在首屏后部分里（主持人 11-05 首屏 ③）
    for (const el of [nav, screen.getByTestId('tabbar-add'), band]) expect(el.hasAttribute('data-kb')).toBe(false);
    // 同一个分包里拦整页双指缩放：挂一次，卸载时一起摘
    expect(kb.zoom).toBe(1);
    view.unmount();
    expect(kb.stops).toBe(1);
    expect(kb.zoomStops).toBe(1);
  });
});
