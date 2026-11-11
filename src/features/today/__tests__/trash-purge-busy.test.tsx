// TC-B4-17 续（B4 S9；代码复审 11-11 必改）：永久删除、全部清空的请求在路上时不能恢复（从 trash-purge.test.tsx 拆出来，准备代码同那边）
// • 请求挂起时“恢复”灰掉；Pressable 的 aria-disabled 只管样子、点击照样触发，真正挡住的是页面 onRestore 里的 busy 判断，
//   所以点完先等恢复那串异步写入落定，再断言没写、没出“已恢复”、行还在；放行后再断言一次（删掉 busy 判断时这两条会挂）
// • 恢复点了、还没写完时点全部清空或永久删除：先等恢复写完再定要发的项（删掉“等恢复写完”这一步时这两条会挂）；
//   这样清空结果一定在“已恢复”之后，页面的 restoreSeq 判断只剩兜底
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
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
  window.history.replaceState(null, '', '/app/#/trash');
  render(<RecentlyDeletedPage />);
  return b;
}

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^trash-row-/);

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

describe('请求在路上时不能恢复（代码复审 11-11 必改）', () => {
  /** 让下一次 RPC 挂起，返回放行函数 */
  const hold = (): ((n: number) => void) => {
    let go: (n: number) => void = () => undefined;
    rpc.mockImplementationOnce(() => new Promise((r) => (go = (n) => r({ data: n, error: null }))));
    return (n) => go(n);
  };
  /** 等恢复那一串异步写入落定：Pressable 的 aria-disabled 只管样子，点击照样触发，要等写入真的有机会发生再断言 */
  const settle = () => act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
  /** 恢复没有生效：没调 enqueue、outbox 里没有这一条、没出“已恢复”、行还在 */
  const notRestored = async (b: Awaited<ReturnType<typeof boot>>, enqueue: { mock: { calls: unknown[] } }, n: number) => {
    expect(enqueue.mock.calls).toEqual([]);
    expect((await b.outbox?.list())?.some((i) => i.id === uid(n))).toBe(false);
    expect(screen.queryByTestId('trash-msg')).toBeNull();
    expect((await b.cache?.getRow(n === 1 ? 'notes' : 'todos', uid(n)))?.view?.['deleted_at']).not.toBeNull();
  };

  it('全部清空挂起时：“恢复”灰掉，点了不生效（不写、不进 outbox）；回来后清空结果不被盖住', async () => {
    const b = await boot();
    const release = hold();
    fireEvent.click(screen.getByTestId('trash-clear'));
    fireEvent.click(await screen.findByTestId('trash-confirm-ok', {}, { timeout: 5000 }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const enqueue = vi.spyOn(b.outbox as NonNullable<typeof b.outbox>, 'enqueue');
    const restore = screen.getByTestId(`trash-restore-${uid(2)}`);
    expect(restore.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(restore);
    await settle();
    expect(screen.getByTestId(`trash-row-${uid(2)}`)).toBeTruthy();
    await notRestored(b, enqueue, 2);
    await act(async () => release(3));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空'));
    await settle();
    await notRestored(b, enqueue, 2);
    expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空');
  });

  it('单条永久删除挂起时：同一条和别的行的“恢复”都灰掉，点了不生效', async () => {
    const b = await boot();
    const release = hold();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const enqueue = vi.spyOn(b.outbox as NonNullable<typeof b.outbox>, 'enqueue');
    for (const n of [1, 2]) {
      const restore = screen.getByTestId(`trash-restore-${uid(n)}`);
      expect(restore.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(restore);
    }
    await settle();
    expect(rows()).toHaveLength(3);
    await notRestored(b, enqueue, 1);
    await notRestored(b, enqueue, 2);
    await act(async () => release(1));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已永久删除'));
    await settle();
    await notRestored(b, enqueue, 2);
    expect(screen.getByTestId(`trash-row-${uid(2)}`)).toBeTruthy();
    expect(screen.getByTestId(`trash-restore-${uid(2)}`).getAttribute('aria-disabled')).toBeNull();
  });

  /** 把下一次 outbox.enqueue（恢复的写入）挂起，返回放行函数 */
  const holdRestore = (b: Awaited<ReturnType<typeof boot>>): (() => void) => {
    const ob = b.outbox as NonNullable<typeof b.outbox>;
    const orig = ob.enqueue.bind(ob);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    vi.spyOn(ob, 'enqueue').mockImplementationOnce(async (input) => {
      await gate;
      return orig(input);
    });
    return () => open();
  };

  it('恢复还没写完就点全部清空：先等恢复写完再定要发的项，这一条不发、不丢；确认框写 2 项；“已清空”不被“已恢复”盖住', async () => {
    const b = await boot();
    const release = holdRestore(b);
    fireEvent.click(screen.getByTestId(`trash-restore-${uid(2)}`));
    await settle();
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    fireEvent.click(screen.getByTestId('trash-clear'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();   // 还在等恢复写完，没弹确认
    await act(async () => release());
    expect(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByText('清空最近删除里的 2 项？清空后不能恢复')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空'));
    const sent = (rpc.mock.calls[0]?.[1] as { p_items: { id: string }[] }).p_items.map((k) => k.id).sort();
    expect(sent).toEqual([uid(1), uid(3)]);
    expect((await b.cache?.getRow('todos', uid(2)))?.view?.['deleted_at']).toBeNull();
    expect((await b.outbox?.list())?.some((i) => i.id === uid(2))).toBe(true);
    await settle();
    expect(screen.queryByTestId('trash-msg')).toBeNull();
    expect(screen.getByTestId('trash-purge-msg').textContent).toBe('已清空');
  });

  it('恢复还没写完就对同一条点永久删除：先等恢复写完，它已经恢复了，不调 RPC', async () => {
    const b = await boot();
    const release = holdRestore(b);
    fireEvent.click(screen.getByTestId(`trash-restore-${uid(1)}`));
    await settle();
    fireEvent.click(screen.getByTestId(`trash-purge-${uid(1)}`));
    fireEvent.click(screen.getByTestId('trash-confirm-ok'));
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => release());
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    expect((await b.cache?.getRow('notes', uid(1)))?.view?.['deleted_at']).toBeNull();
  });
});
