// usage-report 的单元测试（架构 6.1、0.29 续第 116、143 条）：TC-B1-94 ①、TC-B1-102 ⑤ 的 usage-report 部分。
// 只测 core.ts（index.ts 只是把 supabase-js 接上），数据库由假对象代替。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_TIMEOUT_MS, handle, safeEqual, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { settleWithFakeTimers } from './lemo-ops-harness.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';   // ≥ 32 字节
const NOW = Date.parse('2026-10-29T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600_000;
const M = 60_000;

function fakeDb(over: Partial<UsageDb> = {}): UsageDb {
  return {
    heartbeats: async () => [{ name: 'account-purge', at: iso(2 * H), detail: { purged: 1 } }],
    pendingDeletions: async () => [],
    longTxCount: async () => 0,
    ...over,
  };
}

function deps(over: Partial<Deps> = {}): Deps {
  return { opsSecret: SECRET, db: fakeDb(), now: () => NOW, ...over };
}

function req(body: unknown, secret: string | null = SECRET, method = 'POST'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret !== null) headers.set('x-ops-secret', secret);
  return new Request('https://x.supabase.co/functions/v1/usage-report', method === 'GET' ? { method, headers } : { method, headers, body: JSON.stringify(body) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('usage-report 鉴权', () => {
  it('没带或带错 x-ops-secret 回 401，不查数据库', async () => {
    const hb = vi.fn(async () => []);
    for (const s of [null, '', 'wrong', `${SECRET}x`]) {
      const r = await handle(req({ part: 'heartbeat' }, s), deps({ db: fakeDb({ heartbeats: hb }) }));
      expect(r.status).toBe(401);
    }
    expect(hb).not.toHaveBeenCalled();
  });

  it('先鉴权再判“没配好”：没配 OPS_SECRET 时谁都回 401，看不出配没配', async () => {
    for (const s of [null, '', 'anything']) {
      expect((await handle(req({ part: 'heartbeat' }, s), deps({ opsSecret: undefined }))).status).toBe(401);
    }
  });

  it('OPS_SECRET 少于 32 字节：带对了也回 500 misconfigured；带错回 401', async () => {
    const short = 'x'.repeat(31);
    const r = await handle(req({ part: 'heartbeat' }, short), deps({ opsSecret: short }));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'misconfigured' });
    expect((await handle(req({ part: 'heartbeat' }, 'y'.repeat(31)), deps({ opsSecret: short }))).status).toBe(401);
    expect((await handle(req({ part: 'heartbeat' }, 'x'.repeat(32)), deps({ opsSecret: 'x'.repeat(32) }))).status).toBe(200);
  });

  it('函数缺 service role key（db 为 null）：鉴权过了才回 misconfigured', async () => {
    expect((await handle(req({ part: 'heartbeat' }, 'wrong'), deps({ db: null }))).status).toBe(401);
    expect((await handle(req({ part: 'heartbeat' }), deps({ db: null }))).status).toBe(500);
  });

  it('只收 POST；part 不认识回 400；usage 部分 B7 才有，回 501', async () => {
    expect((await handle(req(null, SECRET, 'GET'), deps())).status).toBe(405);
    expect((await handle(req({ part: 'x' }), deps())).status).toBe(400);
    expect((await handle(req({ part: 'usage' }), deps())).status).toBe(501);
  });

  it('safeEqual：长度不同、内容不同都是 false', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', 'a')).toBe(false);
  });

  it('safeEqual：运行环境有 crypto.subtle.timingSafeEqual 时用它（比较的是两段 SHA-256）', async () => {
    const calls: number[] = [];
    const subtle = crypto.subtle as unknown as { timingSafeEqual?: unknown };
    subtle.timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer) => {
      calls.push(a.byteLength, b.byteLength);
      return new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);
    };
    try {
      expect(await safeEqual('abc', 'abc')).toBe(true);
      expect(await safeEqual('abc', 'abcdef')).toBe(false);
      expect(calls).toEqual([32, 32, 32, 32]);
    } finally {
      delete subtle.timingSafeEqual;
    }
  });
});

describe('TC-B1-94 ①：查数据库出错或超时回 503 db_unreachable', () => {
  it('数据库报错：回 503 db_unreachable，不回 200、不回空结果；日志只记错误码', async () => {
    const log = vi.fn();
    const r = await handle(req({ part: 'heartbeat' }), deps({ log, db: fakeDb({ heartbeats: async () => { throw new Error('connect ECONNREFUSED postgres://secret@host'); } }) }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'db_unreachable' });
    expect(log).toHaveBeenCalledWith('db_unreachable:error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('postgres://');
  });

  it('任一项出错都算（冷静期表、长事务）', async () => {
    for (const db of [fakeDb({ pendingDeletions: async () => { throw new Error('x'); } }), fakeDb({ longTxCount: async () => { throw new Error('x'); } })]) {
      expect((await handle(req({ part: 'heartbeat' }), deps({ db }))).status).toBe(503);
    }
  });

  it('查库超过 5 秒：约在 5 秒处回 503，并中止查询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let aborted = false;
    const db = fakeDb({
      heartbeats: (signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (aborted = true));
        }),
    });
    let elapsed = 0;   // 假时钟已推进的毫秒数（Date 没交给假时钟）
    let firedAt = -1;
    const adv = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      elapsed += ms;
    };
    const p = handle(req({ part: 'heartbeat' }), deps({ db })).then((r) => {
      firedAt = elapsed;
      return r;
    });
    const done = await settleWithFakeTimers(p, adv, DB_TIMEOUT_MS + 1000, 50);
    expect(firedAt).toBeGreaterThanOrEqual(DB_TIMEOUT_MS - 100);
    expect(firedAt).toBeLessThanOrEqual(DB_TIMEOUT_MS + 150);
    expect(done.status).toBe(503);
    expect(await done.json()).toEqual({ error: 'db_unreachable' });
    expect(aborted).toBe(true);
  });

  it('正常：回 200，各心跳的 age_s、长事务个数', async () => {
    const r = await handle(req({ part: 'heartbeat' }), deps({ db: fakeDb({ longTxCount: async () => 2 }) }));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = (await r.json()) as { ok: boolean; heartbeats: unknown[]; long_tx: number };
    expect(b.ok).toBe(true);
    expect(b.heartbeats).toEqual([{ name: 'account-purge', age_s: 7200, detail: { purged: 1 } }]);
    expect(b.long_tx).toBe(2);
  });

  it('时间戳坏了：单独回 500 bad_data（不是连不上数据库），不回半截结果', async () => {
    const log = vi.fn();
    const db = fakeDb({ heartbeats: async () => [{ name: 'x', at: 'not-a-date', detail: null }] });
    const r = await handle(req({ part: 'heartbeat' }), deps({ db, log }));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'bad_data' });
    expect(log).toHaveBeenCalledWith('bad_data:timestamp');
  });

  it('detail 只转发白名单里的数字字段', async () => {
    const db = fakeDb({
      heartbeats: async () => [
        { name: 'push-dispatch', at: iso(M), detail: { sent: 3, failed: 5, note: '用户内容', user_id: 'u', ms: '9' } },
        { name: 'ai-classify', at: iso(M), detail: { text: 'x' } },
        { name: 'cleanup', at: iso(M), detail: [1, 2] },
      ],
    });
    const b = (await (await handle(req({ part: 'heartbeat' }), deps({ db }))).json()) as { heartbeats: Array<{ detail: unknown }> };
    expect(b.heartbeats.map((h) => h.detail)).toEqual([{ sent: 3, failed: 5 }, null, null]);
  });
});

describe('TC-B1-102 ⑤：“冷静期中的账号”列出 purge_started_at', () => {
  it('认领了没删完的行：给出 purge_started_at 和距今秒数；不给 user_id', async () => {
    const started = iso(26 * H + M);
    const db = fakeDb({
      pendingDeletions: async () => [
        { purge_after: iso(27 * H), purge_started_at: started },
        { purge_after: iso(-3 * 24 * H), purge_started_at: null },
      ],
    });
    const r = await handle(req({ part: 'heartbeat' }), deps({ db }));
    const b = (await r.json()) as { pending_deletions: Array<Record<string, unknown>> };
    expect(b.pending_deletions[0]).toEqual({ purge_after: iso(27 * H), purge_started_at: started, overdue_s: 27 * 3600, started_age_s: 26 * 3600 + 60 });
    expect(b.pending_deletions[1]).toMatchObject({ purge_started_at: null, started_age_s: null, overdue_s: -3 * 24 * 3600 });
    expect(JSON.stringify(b)).not.toContain('user_id');
  });
});
