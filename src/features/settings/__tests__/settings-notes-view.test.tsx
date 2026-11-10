// 设置 › 随手记显示方式（B4 S1；R-53、R-78；TC-B4-01 设置一半）：首页一行“随手记显示方式 … 瀑布流 ›”和下面的小字“只对本类设备生效”；
// 二级页 #/settings/notes-view 两个选项；切换后记住，只写这台设备类型的键（电脑写 notes.view@desktop、手机写 notes.view@mobile，另一个不动）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { NotesViewSection } from '../ui/NotesViewSection.tsx';
import { renderPage } from './fakes.tsx';

type Row = { id: string; key?: unknown; value?: unknown };
const settings = () => collection<Row>('settings');

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}
const coarse = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));

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
  it('电脑：默认亮“瀑布流”，说明“只对电脑生效”；点“列表”写 notes.view@desktop = list，不写 @mobile；再点“瀑布流”改回', async () => {
    await boot();
    render(<NotesViewSection />);
    expect((screen.getByTestId('settings-notes-view-masonry') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('settings-notes-view').textContent).toContain('只对电脑生效，手机另外设');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-notes-view-list'));
    });
    await waitFor(() => expect(settings().getSnapshot().map((r) => [r.key, r.value])).toEqual([['notes.view@desktop', 'list']]));
    expect((screen.getByTestId('settings-notes-view-list') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-notes-view-masonry'));
    });
    await waitFor(() => expect(settings().getSnapshot().map((r) => [r.key, r.value])).toEqual([['notes.view@desktop', 'masonry']]));
  });

  it('手机（触屏）：说明“只对手机生效”，写 notes.view@mobile', async () => {
    coarse();
    await boot();
    render(<NotesViewSection />);
    expect(screen.getByTestId('settings-notes-view').textContent).toContain('只对手机生效，电脑另外设');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-notes-view-list'));
    });
    await waitFor(() => expect(settings().getSnapshot().map((r) => [r.key, r.value])).toEqual([['notes.view@mobile', 'list']]));
  });
});

describe('首页一行', () => {
  beforeEach(() => window.history.replaceState(null, '', '#/settings'));
  afterEach(() => window.history.replaceState(null, '', '#/settings'));

  it('“随手记显示方式 … 瀑布流 · 只对本类设备生效 ›”一行（稿子第 997 行）；点进 #/settings/notes-view，标题是“随手记显示方式”', async () => {
    await renderPage();
    expect(screen.getByTestId('settings-notes-view-summary').textContent).toBe('瀑布流 · 只对本类设备生效');
    const row = screen.getByTestId('settings-notes-view-entry').closest('li');
    expect(row?.textContent).toContain('随手记显示方式');
    expect(row?.textContent).not.toContain('只对电脑生效');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-notes-view-entry'));
    });
    await screen.findByTestId('settings-notes-view');
    expect(window.location.hash).toBe('#/settings/notes-view');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('随手记显示方式');
  });
});
