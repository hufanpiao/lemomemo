// K8 网络一侧（supabase-js）：错误归类、令牌检查、Realtime 只订阅 INSERT / UPDATE（TC-B1-29）、apply_patch 参数、insert 重发读回 rev、
// report_tz 的 rate_limited 不当错误（K8-tz-rl）
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyFailure } from '../../outbox-logic.ts';
import { createTzReporter, TZ_MIN_INTERVAL_MS } from '../report-tz.ts';
import { createSupabaseTransport, subscribeRealtime, toFailure, toSessionCheck } from '../../../platform/supabase/sync-transport.ts';
import type { RealtimeStatus } from '../types.ts';

describe('toFailure：错误只认码', () => {
  it('plpgsql 的 raise exception 码在 message 里；PostgREST 的码在 code 里；断网', () => {
    expect(toFailure({ message: 'session_revoked', code: 'P0001' }, 400)).toEqual({ status: 400, code: 'session_revoked' });
    expect(toFailure({ message: 'not_found', code: 'P0001' }, 400)).toEqual({ status: 400, code: 'not_found' });
    expect(toFailure({ message: 'JWT expired', code: 'PGRST301' }, 401)).toEqual({ status: 401, code: 'PGRST301' });
    expect(toFailure({ message: 'TypeError: Failed to fetch', code: '' }, 0)).toEqual({ network: true });
    expect(toFailure({ message: 'AbortError: signal timed out' }, 0)).toEqual({ network: true });
  });

  it('426：带出响应体里的 min，outbox 归成 upgrade', () => {
    const f = toFailure({ code: 'upgrade_required', min: '4.1.0' }, 426);
    expect(f).toEqual({ status: 426, code: 'upgrade_required', min: '4.1.0' });
    expect(classifyFailure(f)).toBe('upgrade');
    expect(toFailure({ code: 'upgrade_required', min: 'x' }, 426).min).toBeNull();
  });

  it('归类和 outbox 一致：session_revoked → removed、not_found → drop、401 → auth、503 → transient', () => {
    expect(classifyFailure(toFailure({ message: 'session_revoked' }, 400))).toBe('removed');
    expect(classifyFailure(toFailure({ message: 'account_disabled' }, 400))).toBe('disabled');   // 4.4.1：不丢队列（K6 新类）
    expect(classifyFailure(toFailure({ message: 'not_found' }, 400))).toBe('drop');
    expect(classifyFailure(toFailure({ message: 'JWT expired', code: 'PGRST301' }, 401))).toBe('auth');
    expect(classifyFailure(toFailure({ message: 'Service Unavailable' }, 503))).toBe('transient');
  });

  it('apply_patch 4.4.1：55P03（锁超时）不管 400 还是 500 都是临时失败；patch_table_not_allowed、patch_bad_args → drop', () => {
    expect(toFailure({ message: 'canceling statement due to lock timeout', code: '55P03' }, 500)).toEqual({ status: 500, code: '55P03' });
    expect(classifyFailure(toFailure({ message: 'canceling statement due to lock timeout', code: '55P03' }, 500))).toBe('transient');
    expect(classifyFailure(toFailure({ message: 'canceling statement due to lock timeout', code: '55P03' }, 400))).toBe('transient');
    expect(classifyFailure(toFailure({ message: 'patch_table_not_allowed', code: 'P0001' }, 400))).toBe('drop');
    expect(classifyFailure(toFailure({ message: 'patch_bad_args', code: 'P0001' }, 400))).toBe('drop');
  });

  it('patch_bad_args 的 details（“sqlstate sqlerrm”）只取出 sqlstate，sqlerrm 等服务器原文不带出来（0.38 第 62 条）', () => {
    const f = toFailure({ message: 'patch_bad_args', code: 'P0001', details: '22P02 invalid input syntax for type date: "我的生日"' }, 400);
    expect(f).toEqual({ status: 400, code: 'patch_bad_args', detail: '22P02' });
    expect(JSON.stringify(f)).not.toContain('我的生日');
    expect(toFailure({ message: 'x_y', details: 'Key (id)=(abc) already exists.' }, 409)).toEqual({ status: 409, code: 'x_y' });
  });
});

describe('toSessionCheck', () => {
  it('session_not_found、refresh_token_not_found、session_revoked → removed；断网 → network；别的 → failed', () => {
    expect(toSessionCheck(null)).toBe('ok');
    expect(toSessionCheck({ code: 'session_not_found', status: 400 })).toBe('removed');
    expect(toSessionCheck({ code: 'refresh_token_not_found', status: 400 })).toBe('removed');
    expect(toSessionCheck({ code: 'session_revoked', status: 403 })).toBe('removed');
    expect(toSessionCheck({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' })).toBe('network');
    expect(toSessionCheck({ code: 'unexpected_failure', status: 500 })).toBe('network');   // TC-B1-88 ②：5xx 算临时故障
  });
});

/** 记录调用的假 supabase 客户端（只实现用到的链式方法） */
function fakeClient(result: { data: unknown; error: unknown; status: number }[]) {
  const log: { op: string; args: unknown[] }[] = [];
  const builder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'upsert', 'order', 'limit', 'gte', 'or', 'in', 'eq', 'abortSignal', 'maybeSingle']) {
      b[m] = (...args: unknown[]) => {
        log.push({ op: m, args });
        return b;
      };
    }
    b['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result.shift()).then(res, rej);
    return b;
  };
  const ons: { event: string; table: string }[] = [];
  let statusCb: ((s: string) => void) | null = null;
  const removed: unknown[] = [];
  const channel = {
    on: (_t: string, f: { event: string; table: string }) => {
      ons.push({ event: f.event, table: f.table });
      return channel;
    },
    subscribe: (cb: (s: string) => void) => {
      statusCb = cb;
      return channel;
    },
  };
  const client = {
    from: (table: string) => {
      log.push({ op: 'from', args: [table] });
      return builder();
    },
    rpc: (fn: string, args: unknown) => {
      log.push({ op: 'rpc', args: [fn, args] });
      return builder();
    },
    channel: () => channel,
    removeChannel: (c: unknown) => {
      removed.push(c);
      return Promise.resolve('ok');
    },
    realtime: { setAuth: () => Promise.resolve() },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { expires_at: 2_000 } } }),
      refreshSession: () => Promise.resolve({ error: null }),
    },
  } as unknown as SupabaseClient;
  return { client, log, ons, removed, status: (s: string) => statusCb?.(s) };
}

describe('Realtime 订阅（TC-B1-29）', () => {
  it('同步表只订阅 INSERT、UPDATE（没有 DELETE、没有 *），tombstones 只订阅 INSERT；取消时移除频道', async () => {
    const f = fakeClient([]);
    const statuses: RealtimeStatus[] = [];
    const off = subscribeRealtime(() => Promise.resolve(f.client), ['todos', 'events'], {
      onRow: () => undefined,
      onTombstone: () => undefined,
      onStatus: (s) => statuses.push(s),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.ons).toEqual([
      { event: 'INSERT', table: 'todos' },
      { event: 'UPDATE', table: 'todos' },
      { event: 'INSERT', table: 'events' },
      { event: 'UPDATE', table: 'events' },
      { event: 'INSERT', table: 'tombstones' },
    ]);
    f.status('SUBSCRIBED');
    f.status('CHANNEL_ERROR');
    expect(statuses).toEqual(['up', 'down']);
    off();
    expect(f.removed).toHaveLength(1);
  });
});

describe('请求', () => {
  it('apply_patch 的参数名和 SQL 一致（4.4）；返回值规整', async () => {
    const f = fakeClient([{ data: { status: 'conflict', rev: 7, prev_rev: 5, conflicts: ['title'] }, error: null, status: 200 }]);
    const t = createSupabaseTransport({ client: () => Promise.resolve(f.client) });
    const r = await t.applyPatch({ p_table: 'todos', p_id: 'a', p_patch: { title: 'x' }, p_base_rev: 5, p_op_id: 'op', p_own_revs: [6] });
    expect(r).toEqual({ ok: true, value: { status: 'conflict', rev: 7, prev_rev: 5, conflicts: ['title'] } });
    expect(f.log.find((l) => l.op === 'rpc')?.args).toEqual([
      'apply_patch',
      { p_table: 'todos', p_id: 'a', p_patch: { title: 'x' }, p_base_rev: 5, p_op_id: 'op', p_own_revs: [6] },
    ]);
  });

  it('apply_patch 回了不认识的东西：当服务器出错（transient），不 ack', async () => {
    const f = fakeClient([{ data: { status: 'weird' }, error: null, status: 200 }]);
    const t = createSupabaseTransport({ client: () => Promise.resolve(f.client) });
    const r = await t.applyPatch({ p_table: 'todos', p_id: 'a', p_patch: {}, p_base_rev: 1, p_op_id: 'op', p_own_revs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(classifyFailure(r.error)).toBe('transient');
  });

  it('insert 用 upsert(onConflict: id, ignoreDuplicates)；重发时没回行，按 id 读回 rev', async () => {
    const f = fakeClient([
      { data: [], error: null, status: 201 },
      { data: { rev: 3 }, error: null, status: 200 },
    ]);
    const t = createSupabaseTransport({ client: () => Promise.resolve(f.client) });
    expect(await t.insertRow('todos', { id: 'a', title: 't' })).toEqual({ ok: true, value: { rev: 3 } });
    expect(f.log.find((l) => l.op === 'upsert')?.args[1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
  });

  it('增量拉取：synced_at >= since，键集翻页的 or 条件给时间加引号', async () => {
    const f = fakeClient([{ data: [], error: null, status: 200 }]);
    const t = createSupabaseTransport({ client: () => Promise.resolve(f.client) });
    await t.pullRows('todos', { since: '2026-10-29T00:00:00.000Z', after: { synced_at: '2026-10-29T00:10:00.123456+00:00', id: 'b' }, limit: 500 });
    expect(f.log.find((l) => l.op === 'gte')?.args).toEqual(['synced_at', '2026-10-29T00:00:00.000Z']);
    expect(f.log.find((l) => l.op === 'or')?.args[0]).toBe(
      'synced_at.gt."2026-10-29T00:10:00.123456+00:00",and(synced_at.eq."2026-10-29T00:10:00.123456+00:00",id.gt.b)',
    );
  });

  it('令牌还剩不到 60 秒：先刷新（TC-B1-82 ①）', async () => {
    const f = fakeClient([]);
    let refreshed = 0;
    (f.client.auth as unknown as { refreshSession: () => Promise<unknown> }).refreshSession = () => {
      refreshed++;
      return Promise.resolve({ error: null });
    };
    const t = createSupabaseTransport({ client: () => Promise.resolve(f.client), now: () => 2_000_000 - 50_000 });
    expect(await t.ensureSession()).toBe('ok');
    expect(refreshed).toBe(1);
    const t2 = createSupabaseTransport({ client: () => Promise.resolve(f.client), now: () => 2_000_000 - 120_000 });
    expect(await t2.ensureSession()).toBe('ok');
    expect(refreshed).toBe(1);
  });
});

describe('report_tz（4.6、K8-tz-rl）', () => {
  it('rate_limited：不当错误、不提示，稍后再报；不到 5 分钟不重复报', async () => {
    let now = 0;
    const results = ['rate_limited', 'accepted'] as const;
    let i = 0;
    const logs: string[] = [];
    const r = createTzReporter({
      transport: { reportTz: () => Promise.resolve({ ok: true, value: results[i++] ?? 'unchanged' }) },
      deviceId: () => 'dev',
      platform: 'web',
      currentTz: () => 'Asia/Shanghai',
      now: () => now,
      log: (c) => logs.push(c),
    });
    expect(await r.report(true)).toEqual({ kind: 'reported', result: 'rate_limited', retryLater: true });
    expect(logs).toEqual([]);
    now += TZ_MIN_INTERVAL_MS - 1;
    expect(await r.report()).toEqual({ kind: 'skipped' });
    now += 1;
    expect(await r.report()).toEqual({ kind: 'reported', result: 'accepted', retryLater: false });
  });

  it('没有本会话的设备行不报；函数报错记 report_tz_failed，错误码放 code（日志名不拼码，0.38 第 62 条）', async () => {
    const logs: [string, unknown][] = [];
    const none = createTzReporter({ transport: { reportTz: () => Promise.reject(new Error('不该调')) }, deviceId: () => null, platform: 'web' });
    expect(await none.report(true)).toEqual({ kind: 'skipped' });
    const bad = createTzReporter({
      transport: { reportTz: () => Promise.resolve({ ok: false, error: { status: 400, code: 'device_mismatch' } }) },
      deviceId: () => 'dev',
      platform: 'web',
      log: (c, f) => logs.push([c, f]),
    });
    expect(await bad.report(true)).toEqual({ kind: 'error', code: 'device_mismatch' });
    expect(logs).toEqual([['report_tz_failed', { code: 'device_mismatch' }]]);
  });
});
