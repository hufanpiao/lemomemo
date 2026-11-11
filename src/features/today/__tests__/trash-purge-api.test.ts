// TC-B4-17 续（B4 S9）：“最近删除”永久删除的 hook 和接口层（从 trash-purge.test.tsx 拆出来，页面上的用例在那边）
// • hooks/useTrashPurge.ts：请求途中连点确认不重复发（ok() 里的 busy 判断），请求途中也不弹新的确认
// • data/trash-purge-api.ts：单条按回来的条数判断；全部清空分批传 [{tbl, id}]（每批最多 500），每批单独判断，出错就停；离线不发
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeMany, purgeOne, type PurgeDeps, type PurgeKey, type PurgeManyResult } from '../data/trash-purge-api.ts';
import { forgetPurgedForTest, useTrashPurge, type PurgeApi } from '../hooks/useTrashPurge.ts';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('hooks/useTrashPurge.ts', () => {
  beforeEach(() => forgetPurgedForTest());
  it('ok() 在请求途中再调一次（连点确认）：不重复发；请求途中也不弹新的确认', async () => {
    let done: (v: { done: PurgeKey[]; left: number; err: null }) => void = () => undefined;
    const api: PurgeApi = {
      one: vi.fn(),
      many: vi.fn(() => new Promise<PurgeManyResult>((r) => (done = r))),
      synced: vi.fn(async (k: readonly PurgeKey[]) => k.map(() => true)),
      stillDeleted: vi.fn(async (k: readonly PurgeKey[]) => k.map(() => true)),
    };
    const all = [{ table: 'notes', id: uid(1), deletedAt: 1 }];
    const { result } = renderHook(() => useTrashPurge(all, api));
    act(() => result.current.askAll());
    await waitFor(() => expect(result.current.confirm?.kind).toBe('all'));
    act(() => {
      const ok = result.current.ok;
      ok();
      ok();   // 同一个闭包（confirm 还在）：靠 busy 挡下
    });
    expect(api.many).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    act(() => result.current.askOne('notes', uid(1)));
    expect(result.current.confirm).toBeNull();
    await act(async () => done({ done: [{ tbl: 'notes', id: uid(1) }], left: 0, err: null }));
    expect(result.current.busy).toBe(false);
    expect(result.current.items).toEqual([]);
  });

  it('弹确认以后那条被恢复了（已不在列表里）：确认时不发它', async () => {
    const api: PurgeApi = {
      one: vi.fn(),
      many: vi.fn(async (k: readonly PurgeKey[]) => ({ done: [...k], left: 0, err: null })),
      synced: vi.fn(async (k: readonly PurgeKey[]) => k.map(() => true)),
      stillDeleted: vi.fn(async (k: readonly PurgeKey[]) => k.map(() => true)),
    };
    const a = { table: 'notes', id: uid(1), deletedAt: 1 };
    const b = { table: 'todos', id: uid(2), deletedAt: 1 };
    const { result, rerender } = renderHook(({ all }) => useTrashPurge(all, api), { initialProps: { all: [a, b] } });
    act(() => result.current.askAll());
    await waitFor(() => expect(result.current.confirm?.kind).toBe('all'));
    rerender({ all: [a] });
    await act(async () => result.current.ok());
    expect(api.many).toHaveBeenCalledWith([{ tbl: 'notes', id: uid(1) }]);
  });
});

describe('data/trash-purge-api.ts', () => {
  const deps = (r: () => Promise<{ data: unknown; error: unknown }>, on = true): PurgeDeps & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, online: () => on, rpc: (items) => (calls.push(items), r()) };
  };

  it('单条：回 1 → ok；回 0 → not_synced；回的不是非负整数 → failed', async () => {
    expect(await purgeOne('notes', uid(1), deps(async () => ({ data: 1, error: null })))).toEqual({ ok: true, n: 1 });
    expect(await purgeOne('notes', uid(1), deps(async () => ({ data: 0, error: null })))).toEqual({ ok: false, err: 'not_synced' });
    expect(await purgeOne('notes', uid(1), deps(async () => ({ data: '1', error: null })))).toEqual({ ok: false, err: 'failed' });
  });

  const keys = (n: number): PurgeKey[] => Array.from({ length: n }, (_v, i) => ({ tbl: 'notes', id: uid(i + 1) }));

  it('全部清空分批传 [{tbl, id}]（默认每批 500）：501 项发两批 500 + 1，全对上都算删掉', async () => {
    const calls: number[] = [];
    const d: PurgeDeps = { online: () => true, rpc: (items) => (calls.push(items.length), Promise.resolve({ data: items.length, error: null })) };
    expect(await purgeMany(keys(501), d)).toEqual({ done: keys(501), left: 0, err: null });
    expect(calls).toEqual([500, 1]);
  });

  it('某一批回的条数少了：这批一项都不算删掉，别的批照算；出错就停、后面的批不发', async () => {
    const answers = [2, 1, 1];
    const d = deps(async () => ({ data: answers.shift(), error: null }));
    expect(await purgeMany(keys(5), d, 1000, 2)).toEqual({ done: [...keys(2), keys(5)[4]], left: 2, err: null });
    const seq: { data: unknown; error: unknown }[] = [{ data: 2, error: null }, { data: null, error: { message: 'x' } }];
    const bad = deps(async () => seq.shift() as { data: unknown; error: unknown });
    expect(await purgeMany(keys(5), bad, 1000, 2)).toEqual({ done: keys(2), left: 0, err: 'failed' });
    expect(bad.calls).toHaveLength(2);
  });

  it('离线不发请求；网络错误（TypeError）、超时报 offline', async () => {
    const off = deps(async () => ({ data: 1, error: null }), false);
    expect(await purgeMany(keys(1), off)).toEqual({ done: [], left: 0, err: 'offline' });
    expect(off.calls).toEqual([]);
    expect(await purgeOne('notes', uid(1), deps(() => Promise.reject(new TypeError('Failed to fetch'))))).toEqual({ ok: false, err: 'offline' });
    const slow: PurgeDeps = { online: () => true, rpc: (_i, signal) => new Promise((r) => signal.addEventListener('abort', () => r({ data: null, error: { message: 'aborted' } }))) };
    expect(await purgeOne('todos', uid(2), slow, 5)).toEqual({ ok: false, err: 'offline' });
  });
});
