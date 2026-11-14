// 设置 › 皮肤（ADR-008；R-06、R-20、R-84、R-93；定稿线框第 997 行、皮肤视觉稿第 1368 行）：
// 首页一行“简洁 · 白天 / 夜间跟着手机 ›”和下面两个开关；二级页 #/settings/skin 两组单选（简洁 / 磨砂玻璃、跟着电脑 / 白天 / 夜间），点哪个写哪个键（按账号存）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { SkinSection } from '../ui/SkinSection.tsx';
import { renderPage } from './fakes.tsx';

type Row = { id: string; key?: unknown; value?: unknown };
const settings = () => collection<Row>('settings');
const pairs = () => settings().getSnapshot().map((r) => [r.key, r.value]);

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('二级页', () => {
  it('默认亮“简洁”“跟着电脑”；点“磨砂玻璃”写 ui.skin = glass，点“夜间”写 ui.theme = dark', async () => {
    await boot();
    render(<SkinSection />);
    expect((screen.getByTestId('settings-skin-simple') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('settings-theme-system') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('settings-skin').textContent).toContain('跟着电脑');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-skin-glass'));
    });
    await waitFor(() => expect(pairs()).toEqual([['ui.skin', 'glass']]));
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-theme-dark'));
    });
    await waitFor(() => expect(pairs()).toEqual([['ui.skin', 'glass'], ['ui.theme', 'dark']]));
    expect((screen.getByTestId('settings-skin-glass') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('settings-theme-dark') as HTMLInputElement).checked).toBe(true);
  });

  it('手机（触屏）：“跟随系统”写作“跟着手机”', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
    await boot();
    render(<SkinSection />);
    expect(screen.getByTestId('settings-skin').textContent).toContain('跟着手机');
  });
});

describe('首页', () => {
  beforeEach(() => window.history.replaceState(null, '', '#/settings'));
  afterEach(() => window.history.replaceState(null, '', '#/settings'));

  it('“皮肤 … 简洁 · 白天 / 夜间跟着电脑 ›”在界面语言之后、字体之前的卡 2；点进 #/settings/skin，标题“皮肤”', async () => {
    await renderPage();
    expect(screen.getByTestId('settings-skin-summary').textContent).toBe('简洁 · 白天 / 夜间跟着电脑');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-skin-entry'));
    });
    await screen.findByTestId('settings-skin');
    expect(window.location.hash).toBe('#/settings/skin');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('皮肤');
  });

  it('设置首页不再有“减少透明效果”“减少动态效果”两个开关（11-14 负责人要求去掉，只跟系统设置）', async () => {
    await boot();
    await renderPage();
    expect(screen.queryByTestId('settings-rt')).toBeNull();
    expect(screen.queryByTestId('settings-rm')).toBeNull();
    expect(document.body.textContent).not.toContain('减少透明效果');
    expect(document.body.textContent).not.toContain('减少动态效果');
  });

  it('选过“磨砂玻璃”“夜间”：首页写“磨砂玻璃 · 夜间”', async () => {
    await renderPage();
    act(() => settings().upsert([{ id: 's1', key: 'ui.skin', value: 'glass' }, { id: 's2', key: 'ui.theme', value: 'dark' }]));
    expect(screen.getByTestId('settings-skin-summary').textContent).toBe('磨砂玻璃 · 夜间');
  });
});
