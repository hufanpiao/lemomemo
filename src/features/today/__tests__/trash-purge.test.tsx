// TC-B4-17（B4 S9；架构 0.29 续第 121 条②⑤⑧，R-180；TC-B2-03 第三步）：“最近删除”的永久删除和全部清空
// ① 每行“永久删除”：先弹确认“永久删除后不能恢复”，取消时还在、没调 RPC；确认后只调 purge_deleted([{tbl, id}])，这一行从列表消失
// ② 右上角“全部清空”：确认框写“清空最近删除里的 N 项？清空后不能恢复”，确认后调 purge_deleted([{tbl, id}, …])，列表空了
//   不传 null（代码审 11-11 必改）：只传列表里看得见、服务器那一份也已删除的项；N 就是实际要发的条数；超过 500 项分批，每批单独判断
//   先恢复一条、恢复还没同步就全部清空：这一条不发、不丢
// ③ 离线：两个按钮灰掉、页上写要联网，点了不弹确认、不调 RPC、不进 outbox
// • 服务器回 0 条：服务器那一份还没删除 → 提示还没同步上，行留着；已经删除（墓碑还没来）→“已删除，正在同步”，藏起来
// • 回的条数比这批少：给提示，这批一项都不藏；藏起来的离开这页再回来也不冒出来
// • 本机的行不在这里删（墓碑同步来删，0.29 续第 121 条⑤）；隐私记不进列表，全部清空也不传它（服务器只清普通行，R-193）
// • ④ storage-sweep 孤儿清理按 R-377 不在 B4，这里不测
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
import type { PurgeKey } from '../data/trash-purge-api.ts';
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
const setOnline = (v: boolean): void => {
  online = v;
  window.dispatchEvent(new Event(v ? 'online' : 'offline'));
};

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
  window.history.replaceState(null, '', '/app/#/trash');
  render(<RecentlyDeletedPage />);
  return b;
}

/** 本机删掉一条服务器上还没删除的待办（删除进 outbox、还没发上去） */
async function deleteLocally(b: Awaited<ReturnType<typeof boot>>, n: number): Promise<void> {
  await act(async () => {
    await b.outbox?.applyServer('todos', [{ row: { ...todo(n), deleted_at: null } }]);
    const row = (await b.cache?.getRow('todos', uid(n)))?.view as unknown as Row;
    await setDeleted('todos', row, true, NOW, 'Asia/Seoul' as Tz);
  });
  await screen.findByTestId(`trash-row-${uid(n)}`);
}

const sentKeys = (call: number): PurgeKey[] =>
  [...(rpc.mock.calls[call]?.[1] as { p_items: PurgeKey[] }).p_items].sort((a, b) => a.id.localeCompare(b.id));

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^trash-row-/);
const dialog = (): HTMLElement => screen.getByRole('dialog');

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

describe('① 单条永久删除', () => {
  it('先弹确认，取消时还在、没调 RPC；确认后只调 purge_deleted([{tbl, id}])，这一行消失，出“已永久删除”', async () => {
    await boot();
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    expect(within(dialog()).getByText('永久删除这一项？')).toBeTruthy();
    expect(within(dialog()).getByText('永久删除后不能恢复')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rows()).toHaveLength(3);
    expect(rpc).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已永久删除'));
    expect(rpc.mock.calls).toEqual([['purge_deleted', { p_items: [{ tbl: 'notes', id: uid(1) }] }]]);
    expect(screen.queryByTestId(`trash-row-${uid(1)}`)).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('待办、日程按各自的表传', async () => {
    await boot();
    for (const [n, tbl] of [[2, 'todos'], [3, 'events']] as const) {
      fireEvent.click(screen.getByTestId(`trash-purge-${uid(n)}`));
      fireEvent.click(screen.getByTestId('trash-confirm-ok'));
      await waitFor(() => expect(screen.queryByTestId(`trash-row-${uid(n)}`)).toBeNull());
      expect(rpc.mock.calls.at(-1)).toEqual(['purge_deleted', { p_items: [{ tbl, id: uid(n) }] }]);
    }
  });

  it('服务器回 0 条、服务器那一份还没删除（离线删的、删除还没发上去）：不当成功，行留着，提示还没同步上', async () => {
    const b = await boot();
    await deleteLocally(b, 4);
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(4)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('这一项的删除还没同步上，联网等一会儿再试'));
    expect(screen.getByTestId('trash-purge-msg').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId(`trash-row-${uid(4)}`)).toBeTruthy();
  });

  it('服务器回 0 条、服务器那一份已经删除（之前删掉了、墓碑还没来，比如重开了 app）：写“已删除，正在同步”，藏起来', async () => {
    await boot();
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(2)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已删除，正在同步'));
    expect(screen.getByTestId('trash-purge-msg').getAttribute('role')).toBe('status');
    expect(screen.queryByTestId(`trash-row-${uid(2)}`)).toBeNull();
  });

  it('删掉的离开这页再回来不冒出来（墓碑还没来，本机的行还在）', async () => {
    const b = await boot();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(rows()).toHaveLength(2));
    cleanup();
    render(<RecentlyDeletedPage />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByTestId(`trash-row-${uid(1)}`)).toBeNull();
    expect(await b.cache?.getRow('notes', uid(1))).toBeTruthy();
  });

  it('服务器出错：提示没删成，行留着；本机的行和队列都不动（等墓碑）', async () => {
    const b = await boot();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'session_revoked' } });
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('没删成，请稍后再试'));
    expect(rows()).toHaveLength(3);
    expect(await b.outbox?.list()).toEqual([]);
    expect(await b.cache?.getRow('notes', uid(1))).toBeTruthy();
  });

  it('成功后本机的行还在（不自己删，等墓碑同步）、不进 outbox', async () => {
    const b = await boot();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId(`trash-row-${uid(1)}`)).toBeNull());
    expect(await b.outbox?.list()).toEqual([]);
    expect(await b.cache?.getRow('notes', uid(1))).toBeTruthy();
  });
});

describe('② 全部清空', () => {
  it('确认框写“清空最近删除里的 3 项？清空后不能恢复”（隐私记不算）；确认后只传这 3 项（不传 null），列表空了', async () => {
    await boot();
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    fireEvent.click(screen.getByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 3 项？清空后不能恢复')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空'));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sentKeys(0)).toEqual([{ tbl: 'notes', id: uid(1) }, { tbl: 'todos', id: uid(2) }, { tbl: 'events', id: uid(3) }]);
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('trash-empty')).toBeTruthy();
    expect(screen.queryByTestId('trash-clear')).toBeNull();
  });

  it('取消：不调 RPC，列表不变', async () => {
    await boot();
    fireEvent.click(screen.getByTestId('trash-clear'));
    fireEvent.click(await screen.findByTestId('trash-confirm-cancel', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpc).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
  });

  it('服务器回的条数比这批少（不知道是哪几项）：提示还没同步上，这批一项都不藏', async () => {
    await boot();
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    fireEvent.click(screen.getByTestId('trash-clear'));
    fireEvent.click(await screen.findByTestId('trash-confirm-ok', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('有几项的删除还没同步上，联网等一会儿再试'));
    expect(rows()).toHaveLength(3);
  });

  it('先删掉一条再全部清空：确认框按剩下的条数写', async () => {
    await boot();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 2 项？清空后不能恢复')).toBeTruthy();
  });

  it('先恢复一条、恢复还没同步就全部清空：这一条不发、不丢（服务器上它还是已删除，传 null 就会被清掉）', async () => {
    const b = await boot();
    fireEvent.click(screen.getByTestId(`trash-restore-${uid(2)}`));
    await waitFor(() => expect(screen.getByTestId('trash-msg').textContent).toBe('已恢复'));
    await waitFor(async () => expect((await b.outbox?.list())?.some((i) => i.id === uid(2))).toBe(true));
    expect(screen.queryByTestId(`trash-row-${uid(2)}`)).toBeNull();
    expect((await b.cache?.getRow('todos', uid(2)))?.server?.['deleted_at']).not.toBeNull();   // 恢复还没发上去
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    fireEvent.click(screen.getByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 2 项？清空后不能恢复')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空'));
    expect(sentKeys(0)).toEqual([{ tbl: 'notes', id: uid(1) }, { tbl: 'events', id: uid(3) }]);
    expect((await b.cache?.getRow('todos', uid(2)))?.view?.['deleted_at']).toBeNull();
    expect((await b.outbox?.list())?.some((i) => i.table === 'todos' && i.id === uid(2))).toBe(true);
  });

  it('有一条的删除还没发上去：确认框写实际要删的 3 项并说明这一条先不清；清完它留着，提示还没同步上', async () => {
    const b = await boot();
    await deleteLocally(b, 4);
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    fireEvent.click(screen.getByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 3 项？清空后不能恢复；另有 1 项的删除还没同步上，这次先不清')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('有几项的删除还没同步上，联网等一会儿再试'));
    expect(sentKeys(0).map((k) => k.id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(rows().map((r) => r.getAttribute('data-testid'))).toEqual([`trash-row-${uid(4)}`]);
  });

  it('确认框开着时列表里的全被恢复了：点确认不调 RPC、不出“已清空”', async () => {
    await boot();
    fireEvent.click(screen.getByTestId('trash-clear'));
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    for (const n of [1, 2, 3]) fireEvent.click(screen.getByTestId(`trash-restore-${uid(n)}`));
    await waitFor(() => expect(rows()).toHaveLength(0));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.queryByTestId('trash-purge-msg')).toBeNull();
  });

  it('列表里的都还没发上去：不弹确认、不调 RPC，提示还没同步上', async () => {
    const b = await boot();
    for (const n of [1, 2, 3]) fireEvent.click(screen.getByTestId(`trash-restore-${uid(n)}`));
    await waitFor(() => expect(rows()).toHaveLength(0));
    await deleteLocally(b, 4);
    fireEvent.click(screen.getByTestId('trash-clear'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('这一项的删除还没同步上，联网等一会儿再试'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('③ 离线', () => {
  it('两个按钮灰掉、页上写要联网；点了不弹确认、不调 RPC、不进 outbox；恢复网络后能用', async () => {
    const b = await boot();
    act(() => setOnline(false));
    const clear = screen.getByTestId('trash-clear');
    const one = screen.getByTestId(`trash-purge-${uid(1)}`);
    expect(clear.getAttribute('aria-disabled')).toBe('true');
    expect(one.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('trash-offline').textContent).toBe('永久删除和全部清空要联网');
    fireEvent.click(clear);
    fireEvent.click(one);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(await b.outbox?.list()).toEqual([]);
    // “恢复”不受影响（走 outbox，离线也能点）
    expect(screen.getByTestId(`trash-restore-${uid(1)}`).getAttribute('aria-disabled')).toBeNull();

    act(() => setOnline(true));
    expect(clear.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('trash-offline').textContent).toBe('');
    fireEvent.click(one);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('弹着确认框时断网：点确认报连不上，不当成功', async () => {
    await boot();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    act(() => setOnline(false));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('连不上服务器，联网后再试'));
    expect(rpc).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
  });
});

describe('韩文', () => {
  it('按钮和确认框', async () => {
    uiStore.getState().setLocale('ko-KR');
    await boot();
    expect(screen.getByTestId('trash-clear').textContent).toBe('모두 비우기');
    expect(screen.getByTestId(`trash-purge-${uid(1)}`).textContent).toBe('영구 삭제');
    fireEvent.click(screen.getByTestId('trash-clear'));
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('최근 삭제에 있는 3개 항목을 비울까요? 비우면 복원할 수 없어요')).toBeTruthy();
  });
});
