// App 外壳里的版本横幅（架构师 10-30 第 6 点）：横幅在页面的错误边界外面、和页面同一个 Suspense 里——
// 页面出错时横幅还在；页面分包没到时横幅也不画（启动画面不会提前收起）
import { act, cleanup, render, screen } from '@testing-library/react';
import { lazy, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';

const upgrade = createUpgradeCenter({
  appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(() => Promise.resolve('no_update' as const)), attempt: { get: () => null, set: () => undefined },
});
upgrade.setSwReady();

let loadPage: () => Promise<{ default: ComponentType }> = () => Promise.resolve({ default: () => null });
function Boom(): never {
  throw new Error('page_boom');
}

vi.mock('../../core/boot.ts', () => ({ getBoot: () => ({ upgrade, outbox: null }) }));
vi.mock('../features.ts', () => ({
  featureRoutes: [{ name: 'today', Page: lazy(() => loadPage()) }],
  offRoutes: new Set(),
}));

afterEach(cleanup);

describe('App 里的版本横幅', () => {
  it('页面分包没到：横幅也不画；到了以后页面出错，显示错误状态，横幅还在', async () => {
    let resolve: (m: { default: ComponentType }) => void = () => undefined;
    loadPage = () => new Promise((r) => (resolve = r));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { App } = await import('../App.tsx');
    render(<App />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    await act(async () => resolve({ default: Boom }));
    expect(await screen.findByTestId('app-error')).toBeTruthy();
    expect(screen.getByTestId('update-banner').dataset['kind']).toBe('new_version');
  });
});
