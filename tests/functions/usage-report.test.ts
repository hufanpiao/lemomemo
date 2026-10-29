// usage-report 的单元测试（架构 6.1、0.29 续第 116、143 条）：TC-B1-94 ①、TC-B1-102 ⑤ 的 usage-report 部分。
// 只测 core.ts（index.ts 只是把 supabase-js 接上），数据库由假对象代替。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_MAIL_TIMEOUT_MS, DB_TIMEOUT_MS, handle, safeEqual, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';

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
    // 全程假时钟，不真等 5 秒。以前的写法是“每让出一次事件循环就推 50 ms，最多推 6 秒”：鉴权里的
    // crypto.subtle.digest 走的是真线程池，机器忙时它迟迟不回来，假时钟先推完了，超时计时器才设上，
    // 之后再没人推时钟，handle 永远不返回，于是报 Test timed out in 5000ms（单跑时 digest 很快，所以不出现）。
    // 现在先等假数据库被调用（此时超时计时器已经设上，见 core.ts heartbeatPart），再从这一刻起推假时钟，
    // 结果和机器快慢无关。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let aborted = false;
    let entered!: () => void;
    const queried = new Promise<void>((r) => (entered = r));
    const db = fakeDb({
      heartbeats: (signal) =>
        new Promise(() => {
          entered();
          signal.addEventListener('abort', () => (aborted = true));
        }),
    });
    let settled = false;
    const p = handle(req({ part: 'heartbeat' }), deps({ db })).finally(() => (settled = true));
    await queried;   // 真等（毫秒级）：鉴权的 digest 回来、开始查库；这时还没推过假时钟
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const done = await p;
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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

describe('发信量 auth_mail（架构 0.38 第 12 条；审查必改 1、2）', () => {
  const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

  it('没提供读取器（还没接）：返回体不带 auth_mail', async () => {
    expect('auth_mail' in (await body(await handle(req({ part: 'heartbeat' }), deps())))).toBe(false);
  });

  it('提供了：带上 auth_1h；resend_24h 没给时写 null；多出的键不转发', async () => {
    const one = fakeDb({ authMail: async () => ({ auth_1h: 21 }) });
    expect((await body(await handle(req({ part: 'heartbeat' }), deps({ db: one }))))['auth_mail']).toEqual({ auth_1h: 21, resend_24h: null });
    const two = fakeDb({ authMail: async () => ({ auth_1h: 3, resend_24h: 64, note: 'x' }) as never });
    expect((await body(await handle(req({ part: 'heartbeat' }), deps({ db: two }))))['auth_mail']).toEqual({ auth_1h: 3, resend_24h: 64 });
  });

  it('读出错或数字不对：auth_mail 为 null、只记错误码，心跳照样回 200', async () => {
    const log = vi.fn();
    const err = fakeDb({
      authMail: async () => {
        throw new Error('permission denied for table audit_log_entries');
      },
    });
    const r1 = await handle(req({ part: 'heartbeat' }), deps({ db: err, log }));
    expect(r1.status).toBe(200);
    const b1 = await body(r1);
    expect(b1['auth_mail']).toBeNull();
    expect(b1['heartbeats']).toHaveLength(1);
    expect(log.mock.calls).toEqual([['auth_mail:error']]);
    for (const bad of [{ auth_1h: -1 }, { auth_1h: 1, resend_24h: 1.5 }, { sent_1h: 1 }]) {
      const db = fakeDb({ authMail: async () => bad as never });
      expect((await body(await handle(req({ part: 'heartbeat' }), deps({ db, log }))))['auth_mail']).toBeNull();
    }
    expect(log).toHaveBeenLastCalledWith('auth_mail:bad_data');
  });

  it('发信量读得慢：单独超时，auth_mail 为 null、记 auth_mail:timeout，心跳照常回 200；读取被中止，计时器不留', async () => {
    // 和上面 5 秒那条同一个做法：先真等读取器被调用（鉴权的 digest 走真线程池），计时器设上后再推假时钟
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.fn();
    let aborted = false;
    let entered!: () => void;
    const called = new Promise<void>((r) => (entered = r));
    const db = fakeDb({
      authMail: (signal) =>
        new Promise((_, reject) => {
          entered();
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    let settled = false;
    const pending = handle(req({ part: 'heartbeat' }), deps({ db, log })).finally(() => (settled = true));
    await called;
    await vi.advanceTimersByTimeAsync(AUTH_MAIL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b['auth_mail']).toBeNull();
    expect(b['heartbeats']).toHaveLength(1);
    expect(log.mock.calls).toEqual([['auth_mail:timeout']]);
    expect(aborted).toBe(true);
    expect(AUTH_MAIL_TIMEOUT_MS).toBeLessThan(DB_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('整轮已回 503 后，发信量那边不再补记 auth_mail:error，计时器不留', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.fn();
    let failMail: (e: Error) => void = () => {};
    const db = fakeDb({
      heartbeats: async () => {
        throw new Error('connection refused');
      },
      authMail: () =>
        new Promise((_, reject) => {
          failMail = reject;
        }),
    });
    const r = await handle(req({ part: 'heartbeat' }), deps({ db, log }));
    expect(r.status).toBe(503);
    failMail(new Error('late'));
    await vi.advanceTimersByTimeAsync(AUTH_MAIL_TIMEOUT_MS * 2);
    expect(log.mock.calls).toEqual([['db_unreachable:error']]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
