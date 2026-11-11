// TC-B4-09 × TC-B4-17：只读行（要新版本，R-148）进了“最近删除”也照样只读——标“要新版本”、“恢复”“永久删除”都灰掉，点了只提示、不写、不调 RPC
// • 准备代码同 trash-purge.test.tsx；只读行按宽容读取交给 applyServer 的格式 {row, ro: true} 灌进本机库
// • 写入入口统一拦下（TC-B4-09，主持人 11-11 定）：全部清空跳过只读行，它们留在列表里、确认框的条数不算它们、另写“会留下”；
//   清完出“已清空；另有 N 项要新版本才能删除，留在列表里”，没清全的接在 partial 后面；全是只读行时不弹确认、直接出“这 N 项……”（增量复审 11-11）；
//   确认以后再按只读核一遍，确认框开着时变成只读的不发；在忙（请求在路上）时点只读行不出提示
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { setDeleted } from '../data/today-actions.ts';
import type { Row } from '../data/today-model.ts';
import { forgetPurgedForTest } from '../hooks/useTrashPurge.ts';
import RecentlyDeletedPage from '../ui/RecentlyDeletedPage.tsx';

const rpc = vi.fn<(fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>();
vi.mock('../../../platform/supabase/client.ts', () => ({
  getSupabase: async () => ({ rpc: (fn: string, args: unknown) => ({ abortSignal: () => rpc(fn, args) }) }),
}));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { deleted_at: NOW - DAY, undone: false, created_at: 1, updated_at: 1, rev: 2 };
const note = (n: number, over: Record<string, unknown> = {}) =>
  ({
    id: uid(n), title: null, body: `随手记${n}`, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, ...base, ...over,
  }) as ServerRow;
const todo = (n: number) => ({ id: uid(n), title: `待办${n}`, done: false, due: null, ...base }) as ServerRow;
const event = (n: number) => ({ id: uid(n), title: `日程${n}`, start_at: NOW, end_at: NOW + 3_600_000, all_day: false, ...base }) as ServerRow;

let online = true;

async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  // A 的“最近删除”里 3 条（一条随手记、一条待办、一条日程）＋ 一条隐私记（不进列表）
  await act(async () => {
    await b.outbox?.applyServer('notes', [{ row: note(1) }, { row: note(9, { is_private: true, body: null }) }]);
    await b.outbox?.applyServer('todos', [{ row: todo(2) }]);
    await b.outbox?.applyServer('events', [{ row: event(3) }]);
  });
  // 只读的那几条（宽容读取认不出值时交给 applyServer 的格式 {row, ro: true}）：随手记、待办、日程各一条，都在“最近删除”里
  await act(async () => {
    await b.outbox?.applyServer('notes', [{ row: note(5), ro: true }]);
    await b.outbox?.applyServer('todos', [{ row: todo(6), ro: true }]);
    await b.outbox?.applyServer('events', [{ row: event(7), ro: true }]);
  });
  window.history.replaceState(null, '', '/app/#/trash');
  render(<RecentlyDeletedPage />);
  return b;
}


beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  online = true;
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  forgetPurgedForTest();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 1, error: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('只读行进了“最近删除”也照样只读', () => {
  it('随手记、待办、日程的只读行都标“要新版本”，“恢复”灰掉；正常行不标、能恢复', async () => {
    await boot();
    for (const n of [5, 6, 7]) {
      expect((await screen.findByTestId(`trash-ro-${uid(n)}`)).textContent).toContain('要新版本');
      expect(screen.getByTestId(`trash-restore-${uid(n)}`).getAttribute('aria-disabled')).toBe('true');
    }
    for (const n of [1, 2, 3]) {
      expect(screen.queryByTestId(`trash-ro-${uid(n)}`)).toBeNull();
      expect(screen.getByTestId(`trash-restore-${uid(n)}`).getAttribute('aria-disabled')).toBeNull();
    }
  });

  it('点只读行的“恢复”：提示“这条要新版本才能修改”，不写、不进 outbox，本机这一行还是已删除、还在列表里', async () => {
    const b = await boot();
    const enqueue = vi.spyOn(b.outbox as NonNullable<typeof b.outbox>, 'enqueue');
    for (const [n, tbl] of [[5, 'notes'], [6, 'todos'], [7, 'events']] as const) {
      fireEvent.click(await screen.findByTestId(`trash-restore-${uid(n)}`));
      await waitFor(() => expect(screen.getByTestId('trash-msg').textContent).toBe('这条要新版本才能修改'));
      await act(async () => {
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect((await b.cache?.getRow(tbl, uid(n)))?.view?.['deleted_at']).not.toBeNull();
      expect(screen.getByTestId(`trash-row-${uid(n)}`)).toBeTruthy();
    }
    expect(await b.outbox?.list()).toEqual([]);
  });

  it('点只读行的“永久删除”：灰掉，只提示“这条要新版本才能修改”，不弹确认、不调 RPC', async () => {
    await boot();
    for (const n of [5, 6, 7]) {
      const del = await screen.findByTestId(`trash-purge-${uid(n)}`);
      expect(del.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(del);
      expect(screen.getByTestId('trash-msg').textContent).toBe('这条要新版本才能修改');
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(screen.getByTestId(`trash-purge-${uid(1)}`).getAttribute('aria-disabled')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('全部清空跳过只读行：确认框只算 3 条正常的，只发这 3 条；只读的 3 条留在列表里，清完出“已清空；另有 3 项要新版本才能删除，留在列表里”', async () => {
    await boot();
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    fireEvent.click(await screen.findByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 3 项？清空后不能恢复；另有 3 项要新版本才能删除，会留下')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空；另有 3 项要新版本才能删除，留在列表里'));
    const sent = (rpc.mock.calls[0]?.[1] as { p_items: { id: string }[] }).p_items.map((k) => k.id).sort();
    expect(sent).toEqual([uid(1), uid(2), uid(3)]);
    expect(screen.queryAllByTestId(/^trash-row-/).map((r) => r.getAttribute('data-testid')).sort()).toEqual([5, 6, 7].map((n) => `trash-row-${uid(n)}`));
  });

  it('列表里只剩只读行时点全部清空：不弹确认、不调 RPC，直接提示', async () => {
    await boot();
    for (const n of [1, 2, 3]) fireEvent.click(await screen.findByTestId(`trash-restore-${uid(n)}`));
    await waitFor(() => expect(screen.queryAllByTestId(/^trash-row-/)).toHaveLength(3));
    fireEvent.click(screen.getByTestId('trash-clear'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('这 3 项要新版本才能删除，留在列表里'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('没清全（服务器回的条数对不上）：partial 后面也接上留下的只读条数', async () => {
    await boot();
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    fireEvent.click(await screen.findByTestId('trash-clear'));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() =>
      expect(screen.getByTestId('trash-purge-msg').textContent).toBe('有几项的删除还没同步上，联网等一会儿再试；另有 3 项要新版本才能删除，留在列表里'),
    );
  });

  it('清空过（留下只读的）以后再单条永久删除、报还没同步上：只出单条的提示，不接上次清空留下的只读条数', async () => {
    const b = await boot();
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    fireEvent.click(await screen.findByTestId('trash-clear'));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空；另有 3 项要新版本才能删除，留在列表里'));
    // 本机刚删的一条待办，删除还没发上去（服务器那一份没删除）
    await act(async () => {
      await b.outbox?.applyServer('todos', [{ row: { ...todo(4), deleted_at: null } }]);
      const row = (await b.cache?.getRow('todos', uid(4)))?.view as unknown as Row;
      await setDeleted('todos', row, true, NOW, 'Asia/Seoul' as Tz);
    });
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    fireEvent.click(await screen.findByTestId(`trash-purge-${uid(4)}`));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('这一项的删除还没同步上，联网等一会儿再试'));
    expect(screen.getByTestId(`trash-row-${uid(4)}`)).toBeTruthy();
  });

  it('全部清空确认以后再按只读核一遍：确认框开着时变成只读的不发，算进留下的条数', async () => {
    const b = await boot();
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    fireEvent.click(await screen.findByTestId('trash-clear'));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: note(1), ro: true }]);
    });
    await screen.findByTestId(`trash-ro-${uid(1)}`);
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空；另有 4 项要新版本才能删除，留在列表里'));
    const sent = (rpc.mock.calls[0]?.[1] as { p_items: { id: string }[] }).p_items.map((k) => k.id).sort();
    expect(sent).toEqual([uid(2), uid(3)]);
    expect(screen.getByTestId(`trash-row-${uid(1)}`)).toBeTruthy();
  });

  it('单条：确认框开着时变成只读了，点确认只提示“这条要新版本才能修改”、不调 RPC', async () => {
    const b = await boot();
    fireEvent.click(await screen.findByTestId(`trash-purge-${uid(2)}`));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await act(async () => {
      await b.outbox?.applyServer('todos', [{ row: todo(2), ro: true }]);
    });
    await screen.findByTestId(`trash-ro-${uid(2)}`);
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('这条要新版本才能修改'));
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.getByTestId(`trash-row-${uid(2)}`)).toBeTruthy();
  });

  it('请求在路上（busy）时点只读行的“永久删除”：不出提示', async () => {
    await boot();
    rpc.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(await screen.findByTestId('trash-clear'));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.getByTestId('trash-clear').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(5)}`));
    expect(screen.queryByTestId('trash-msg')).toBeNull();
  });
});
