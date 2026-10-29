// 最近的导出（data/recent-exports.ts；R-256 ②④；架构 0.29 续第 96 条③；数据字典 4.6 logs：
// export_mail_failed 的 code = 对应 export 行 t 的 ISO，按 device + code 配对）
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import {
  createRecentExportsApi,
  listExports,
  RECENT_EXPORT_DAYS,
  RECENT_EXPORT_FUTURE_SKEW_MS,
  RECENT_EXPORT_RECHECK_MS,
  type ExportLogRow,
  type RecentExportResult,
} from '../data/recent-exports.ts';
import { useRecentExport } from '../hooks/useRecentExport.ts';

const NOW = Date.parse('2026-10-30T03:00:00Z');
const DAY = 86_400_000;
const SINCE = NOW - RECENT_EXPORT_DAYS * DAY;
const UNTIL = NOW + RECENT_EXPORT_FUTURE_SKEW_MS;
const T1 = Date.parse('2026-10-29T03:00:00Z');
const T2 = Date.parse('2026-10-29T03:00:30Z');
const T3 = Date.parse('2026-10-20T08:15:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const exp = (t: number, device: string | null = 'd1'): ExportLogRow => ({ t, device, act: 'export', code: null });
const mailFail = (t: number, of: number, device: string | null = 'd1'): ExportLogRow => ({ t, device, act: 'export_mail_failed', code: iso(of) });

describe('listExports', () => {
  it('多条：列出全部 export，按时间倒序（不管读回来的先后），每条带设备号；邮件都发出去时都不标', () => {
    expect(listExports([exp(T3, 'd2'), exp(T2), exp(T1)], SINCE)).toEqual([
      { at: T2, device: 'd1', mailFailed: false },
      { at: T1, device: 'd1', mailFailed: false },
      { at: T3, device: 'd2', mailFailed: false },
    ]);
  });

  it('邮件失败的：只有配上的那一条标出来（同一台设备连着两次，按 code 分得开）', () => {
    expect(listExports([exp(T2), exp(T1), mailFail(T1 + 5000, T1)], SINCE)).toEqual([
      { at: T2, device: 'd1', mailFailed: false },
      { at: T1, device: 'd1', mailFailed: true },
    ]);
  });

  it('device 也要对上：别的设备的失败行不算；两边都没有设备号也能配上；设备号大小写不同也算同一台', () => {
    expect(listExports([exp(T2, 'd1'), mailFail(T2 + 1, T2, 'd2')], SINCE)[0]?.mailFailed).toBe(false);
    expect(listExports([exp(T2, null), mailFail(T2 + 1, T2, null)], SINCE)).toEqual([{ at: T2, device: null, mailFailed: true }]);
    expect(listExports([exp(T2, 'ABC'), mailFail(T2 + 1, T2, 'abc')], SINCE)).toEqual([{ at: T2, device: 'abc', mailFailed: true }]);
  });

  it('没有记录的：空、只有失败行、只有 90 天以前的 export 都是空列表', () => {
    expect(listExports([], SINCE)).toEqual([]);
    expect(listExports([mailFail(T1, T1)], SINCE)).toEqual([]);
    expect(listExports([exp(SINCE - 1)], SINCE)).toEqual([]);
  });

  it('时间在将来的行丢掉（R-259 减轻措施）：晚于 现在 + 5 分钟 的 export 不列、失败行不配；5 分钟以内的照常', () => {
    expect(listExports([exp(UNTIL + 1), exp(T1)], SINCE, UNTIL)).toEqual([{ at: T1, device: 'd1', mailFailed: false }]);
    expect(listExports([exp(T1), mailFail(UNTIL + 1, T1)], SINCE, UNTIL)).toEqual([{ at: T1, device: 'd1', mailFailed: false }]);
    expect(listExports([exp(UNTIL), mailFail(UNTIL, UNTIL)], SINCE, UNTIL)).toEqual([{ at: UNTIL, device: 'd1', mailFailed: true }]);
  });
});

/** 记下查询条件的假 db */
function fakeDb(result: { data: unknown; error: unknown } | (() => Promise<never>)) {
  const calls: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order']) {
    chain[m] = (...a: unknown[]) => {
      calls.push([m, ...a]);
      return chain;
    };
  }
  chain['limit'] = (n: number) => {
    calls.push(['limit', n]);
    return typeof result === 'function' ? result() : Promise.resolve(result);
  };
  const db = { from: (t: string) => (calls.push(['from', t]), chain) } as unknown as Db;
  return { db, calls };
}

describe('createRecentExportsApi', () => {
  it('经 RLS 读本人的 logs：src = account、kind = run、两种 act、最近 90 天且不晚于 现在 + 5 分钟、按 t 倒序；有记录就是 ready', async () => {
    const { db, calls } = fakeDb({ data: [exp(UNTIL + 60_000), mailFail(T2 + 1, T2), exp(T2), exp(T1)], error: null });
    const api = createRecentExportsApi(async () => db, { now: () => NOW });
    expect(await api.list()).toEqual({
      kind: 'ready',
      list: [
        { at: T2, device: 'd1', mailFailed: true },
        { at: T1, device: 'd1', mailFailed: false },
      ],
    });
    expect(calls).toEqual([
      ['from', 'logs'],
      ['select', 't,device,act,code'],
      ['eq', 'src', 'account'],
      ['eq', 'kind', 'run'],
      ['in', 'act', ['export', 'export_mail_failed']],
      ['gte', 't', SINCE],
      ['lte', 't', UNTIL],
      ['order', 't', { ascending: false }],
      ['limit', 600],
    ]);
  });

  it('没有记录：none；t 是字符串（bigint 经 PostgREST 有时是字符串）也认', async () => {
    expect(await createRecentExportsApi(async () => fakeDb({ data: [], error: null }).db, { now: () => NOW }).list()).toEqual({ kind: 'none' });
    const s = fakeDb({ data: [{ t: String(T1), device: 'd1', act: 'export', code: null }], error: null });
    expect(await createRecentExportsApi(async () => s.db, { now: () => NOW }).list()).toEqual({
      kind: 'ready',
      list: [{ at: T1, device: 'd1', mailFailed: false }],
    });
  });

  it('读失败的：PostgREST 回错、抛异常、拿不到客户端、超时都是 hidden（不报错）', async () => {
    const opt = { now: () => NOW };
    expect(await createRecentExportsApi(async () => fakeDb({ data: null, error: { code: '42501' } }).db, opt).list()).toEqual({ kind: 'hidden' });
    expect(await createRecentExportsApi(async () => fakeDb(() => Promise.reject(new TypeError('Failed to fetch'))).db, opt).list()).toEqual({ kind: 'hidden' });
    expect(await createRecentExportsApi(async () => Promise.reject(new Error('supabase_env_missing')), opt).list()).toEqual({ kind: 'hidden' });
    const never = fakeDb(() => new Promise<never>(() => undefined));
    vi.useFakeTimers();
    try {
      const p = createRecentExportsApi(async () => never.db, { ...opt, timeoutMs: 100 }).list();
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toEqual({ kind: 'hidden' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useRecentExport', () => {
  const ok = async (): Promise<RecentExportResult> => ({ kind: 'none' });

  it('打开读一次；导出成功（tick 变）立刻读一次，5 秒后再读一次；之后不再读', async () => {
    vi.useFakeTimers();
    try {
      const api = { list: vi.fn(ok) };
      const { rerender } = renderHook(({ tick }) => useRecentExport(api, tick), { initialProps: { tick: 0 } });
      await act(async () => vi.advanceTimersByTimeAsync(RECENT_EXPORT_RECHECK_MS * 2));
      expect(api.list).toHaveBeenCalledTimes(1);
      rerender({ tick: 1 });
      expect(api.list).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(RECENT_EXPORT_RECHECK_MS - 1));
      expect(api.list).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(api.list).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(RECENT_EXPORT_RECHECK_MS * 3));
      expect(api.list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5 秒内卸载：定时器清掉，不再读', async () => {
    vi.useFakeTimers();
    try {
      const api = { list: vi.fn(ok) };
      const { rerender, unmount } = renderHook(({ tick }) => useRecentExport(api, tick), { initialProps: { tick: 0 } });
      rerender({ tick: 1 });
      expect(api.list).toHaveBeenCalledTimes(2);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(RECENT_EXPORT_RECHECK_MS * 2));
      expect(api.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
