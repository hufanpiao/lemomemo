// usage-report 的“没有 profile 的 auth 用户”（接手清单 ORPHAN-alert；架构 0.38 第 29 条）：core.ts 的 orphanUsers、orphansFromRpc。
// 和发信量（usage-report.test.ts 的 auth_mail）同一个做法：单独计时、出错只让 orphan_users 为 null，不连累心跳。
// lemo-ops 那一半在 lemo-ops-orphan.test.ts，数据库那一半在 supabase/tests/rls/27_orphan_auth_users.test.sql。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle, ORPHAN_TIMEOUT_MS, orphansFromRpc, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const H = 3600_000;

function fakeDb(over: Partial<UsageDb> = {}): UsageDb {
  return { heartbeats: async () => [], pendingDeletions: async () => [], longTxCount: async () => 0, ...over };
}
const deps = (over: Partial<Deps> = {}): Deps => ({ opsSecret: SECRET, db: fakeDb(), now: () => NOW, ...over });
const req = () => new Request('https://x.supabase.co/functions/v1/usage-report', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-secret': SECRET }, body: JSON.stringify({ part: 'heartbeat' }),
});
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

afterEach(() => {
  vi.useRealTimers();
});

describe('usage-report：没有 profile 的 auth 用户 orphan_users（ORPHAN-alert）', () => {
  it('没提供读取器（还没接）：返回体不带 orphan_users', async () => {
    expect('orphan_users' in (await body(await handle(req(), deps())))).toBe(false);
  });

  it('读到了：给个数和最近一个距今多少秒（不给时刻原文、不给 id）；没有孤儿时 latest_age_s 为 null', async () => {
    const db = fakeDb({ orphanUsers: async () => ({ count: 2, latest_at: new Date(NOW - 2 * H).toISOString() }) });
    expect((await body(await handle(req(), deps({ db }))))['orphan_users']).toEqual({ count: 2, latest_age_s: 7200 });
    const none = fakeDb({ orphanUsers: async () => ({ count: 0, latest_at: null }) });
    expect((await body(await handle(req(), deps({ db: none }))))['orphan_users']).toEqual({ count: 0, latest_age_s: null });
  });

  it('index.ts 接 rpc orphan_auth_users：一行的数组取 orphans、latest_at；空数组、null、缺键交给校验判 bad_data', async () => {
    expect(orphansFromRpc([{ orphans: 3, latest_at: '2026-10-31T10:00:00+00:00' }])).toEqual({ count: 3, latest_at: '2026-10-31T10:00:00+00:00' });
    expect(orphansFromRpc({ orphans: 0, latest_at: null })).toEqual({ count: 0, latest_at: null });
    for (const bad of [[], null, undefined, [{ latest_at: null }], [null], 'x']) {
      const log = vi.fn();
      const db = fakeDb({ orphanUsers: async () => orphansFromRpc(bad) });
      const r = await handle(req(), deps({ db, log }));
      expect(r.status).toBe(200);
      expect((await body(r))['orphan_users']).toBeNull();
      expect(log.mock.calls).toEqual([['orphans:bad_data']]);
    }
  });

  it('读出错或数字不对：orphan_users 为 null、只记错误码，心跳照样回 200', async () => {
    const log = vi.fn();
    const db = fakeDb({ orphanUsers: async () => { throw new Error('permission denied for table users'); } });
    const r = await handle(req(), deps({ db, log }));
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b['orphan_users']).toBeNull();
    expect(b['heartbeats']).toEqual([]);
    expect(log.mock.calls).toEqual([['orphans:error']]);
    for (const bad of [{ count: -1, latest_at: null }, { count: 1.5, latest_at: null }, { count: 2, latest_at: null }, { count: 1, latest_at: 'not-a-date' }, { count: '1', latest_at: null }]) {
      const log2 = vi.fn();
      const db2 = fakeDb({ orphanUsers: async () => bad as never });
      expect((await body(await handle(req(), deps({ db: db2, log: log2 }))))['orphan_users']).toBeNull();
      expect(log2.mock.calls).toEqual([['orphans:bad_data']]);
    }
  });

  it('读得慢：单独超时，orphan_users 为 null、记 orphans:timeout，心跳照常回 200；读取被中止，计时器不留', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.fn();
    let aborted = false;
    let entered!: () => void;
    const called = new Promise<void>((r) => (entered = r));
    const db = fakeDb({
      orphanUsers: (signal) => new Promise((_, reject) => {
        entered();
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    });
    let settled = false;
    const pending = handle(req(), deps({ db, log })).finally(() => (settled = true));
    await called;
    await vi.advanceTimersByTimeAsync(ORPHAN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r.status).toBe(200);
    expect((await body(r))['orphan_users']).toBeNull();
    expect(log.mock.calls).toEqual([['orphans:timeout']]);
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('整轮已回 503 后，孤儿那边不再补记日志，计时器不留；和发信量同时接时互不影响', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.fn();
    let fail: (e: Error) => void = () => {};
    const db = fakeDb({
      heartbeats: async () => { throw new Error('connection refused'); },
      orphanUsers: () => new Promise((_, reject) => { fail = reject; }),
    });
    expect((await handle(req(), deps({ db, log }))).status).toBe(503);
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(ORPHAN_TIMEOUT_MS * 2);
    expect(log.mock.calls).toEqual([['db_unreachable:error']]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    const both = fakeDb({ authMail: async () => { throw new Error('x'); }, orphanUsers: async () => ({ count: 1, latest_at: new Date(NOW - H).toISOString() }) });
    const log2 = vi.fn();
    const b = await body(await handle(req(), deps({ db: both, log: log2 })));
    expect(b['auth_mail']).toBeNull();
    expect(b['orphan_users']).toEqual({ count: 1, latest_age_s: 3600 });
    expect(log2.mock.calls).toEqual([['auth_mail:error']]);
  });
});
