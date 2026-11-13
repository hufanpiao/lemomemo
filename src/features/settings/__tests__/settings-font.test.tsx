// 设置 › 字体（架构 5.9c；R-128、R-135；定稿线框 s13“字体 › 系统字体（默认）”）：
// 首页一行的值（默认“系统字体（默认）”、选中的字体名、下载中 xx%、失败）；二级页单选 = 系统字体 + 清单里有的字体，点了写 ui.font = {v: 1, id}；
// 设置里的值清单里没有（源字体还没放进来）按系统字体显示；失败时有“重试”。下载、套上本身在 platform/__tests__/fonts.test.ts
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { FontState } from '../../../platform/fonts.ts';
import { FontHomeRow, FontSection } from '../ui/FontSection.tsx';

const m = vi.hoisted(() => {
  let state: FontState = { id: 'system', status: 'ok', pct: 100 };
  const subs = new Set<() => void>();
  return {
    fonts: [] as unknown[],
    retry: vi.fn(() => Promise.resolve()),
    setState(s: FontState) {
      state = s;
      for (const l of subs) l();
    },
    fontState: {
      get: () => state,
      subscribe(l: () => void) {
        subs.add(l);
        return () => subs.delete(l);
      },
    },
  };
});
vi.mock('../../../platform/fonts.ts', () => ({ fontIndex: () => Promise.resolve(m.fonts), fontState: m.fontState, retryFont: m.retry }));

const KAI = { id: 'kai', label: { zh: '文楷', ko: '손글씨' }, css: '', family: '', sample: '', prefetch: [] };
type Row = { id: string; key?: unknown; value?: unknown };
const settings = () => collection<Row>('settings');

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

beforeEach(async () => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  m.fonts = [KAI];
  m.setState({ id: 'system', status: 'ok', pct: 100 });
  m.retry.mockClear();
  await boot();
});
afterEach(() => {
  cleanup();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('二级页', () => {
  it('系统字体 + 清单里的字体；默认亮系统字体，点“文楷”写 ui.font = {v: 1, id: kai}', async () => {
    render(<FontSection />);
    await screen.findByTestId('settings-font-kai');
    expect((screen.getByTestId('settings-font-system') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-font-kai'));
    });
    await waitFor(() => expect(settings().getSnapshot().find((r) => r.key === 'ui.font')?.value).toEqual({ v: 1, id: 'kai' }));
    expect((screen.getByTestId('settings-font-kai') as HTMLInputElement).checked).toBe(true);
  });

  it('清单是空的（源字体还没放进来）：只有系统字体；韩文界面显示韩文名', async () => {
    m.fonts = [];
    render(<FontSection />);
    await act(async () => Promise.resolve());
    expect(screen.queryByTestId('settings-font-kai')).toBeNull();
    expect(screen.getByTestId('settings-font-system')).toBeTruthy();
    cleanup();
    m.fonts = [KAI];
    uiStore.getState().setLocale('ko-KR');
    render(<FontSection />);
    expect((await screen.findByTestId('settings-font')).textContent).toContain('손글씨');
  });

  it('下载失败：提示“没下载成功，先用系统字体”，点“重试”', async () => {
    settings().upsert([{ id: 'f', key: 'ui.font', value: { v: 1, id: 'kai' } }] as never);
    m.setState({ id: 'kai', status: 'fail', pct: 0 });
    render(<FontSection />);
    await screen.findByText('没下载成功，先用系统字体');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(m.retry).toHaveBeenCalledTimes(1);
  });
});

describe('首页一行', () => {
  it('默认“系统字体（默认）”；选了文楷写字体名；下载中写进度；值不在清单里按系统字体', async () => {
    render(<FontHomeRow onOpen={() => undefined} />);
    const v = () => screen.getByTestId('settings-font-summary').textContent;
    await act(async () => Promise.resolve());
    expect(v()).toBe('系统字体（默认）');
    await act(async () => {
      settings().upsert([{ id: 'f', key: 'ui.font', value: { v: 1, id: 'kai' } }] as never);
    });
    await waitFor(() => expect(v()).toBe('文楷'));
    act(() => m.setState({ id: 'kai', status: 'loading', pct: 40 }));
    expect(v()).toBe('下载中 40%');
    await act(async () => {
      settings().upsert([{ id: 'f', key: 'ui.font', value: { v: 1, id: 'round' } }] as never);
    });
    await waitFor(() => expect(v()).toBe('系统字体（默认）'));
  });
});
