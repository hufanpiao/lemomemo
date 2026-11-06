// 版本横幅本体按需下载（11-05 首屏瘦身，主持人定第 4 项）：平时没有横幅，UpdateBanner.tsx 不加载；
// 有横幅要出了（这里是 SW 装好新版本）才加载、画出来；用着用着来的横幅不把页面藏起来
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';

const upgrade = createUpgradeCenter({
  appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(() => Promise.resolve('no_update' as const)), attempt: { get: () => null, set: () => undefined },
});

let loads = 0;
vi.mock('../UpdateBanner.tsx', async (importOriginal) => {
  loads += 1;
  return importOriginal();
});
vi.mock('../../core/boot.ts', () => ({ getBoot: () => ({ upgrade, outbox: null }) }));
vi.mock('../features.ts', () => ({
  featureRoutes: [{ name: 'today', Page: () => <main data-testid="page">page</main> }],
  offRoutes: new Set(),
}));

afterEach(cleanup);

describe('横幅关口', () => {
  it('没有横幅：不加载 UpdateBanner.tsx；SW 装好新版本以后才加载并画出，页面一直在', async () => {
    const { App } = await import('../App.tsx');
    render(<App />);
    expect(await screen.findByTestId('page')).toBeTruthy();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(loads).toBe(0);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => upgrade.setSwReady());
    expect(screen.getByTestId('page')).toBeTruthy();
    expect((await screen.findByTestId('update-banner')).dataset['kind']).toBe('new_version');
    expect(loads).toBe(1);
  });
});
