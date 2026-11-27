// account 函数 status 一组的单元测试（从 account.test.ts 拆出，ACCOUNT-sugg ①）：登录后判断要不要显示恢复页（10-30 架构师）。
//   只测 core.ts（经它转出的 status.ts）；status 不碰数据库、不计次、不发信。
import { describe, expect, it } from 'vitest';
import { ACCOUNT_DAILY_LIMIT, ACCOUNT_STATUS_VALUES } from '../../supabase/functions/account/core.ts';
import { ACCOUNT_STATUSES, accountStatusResponse } from '../../shared/schema/account.ts';
import { A, type accountDeps, B, accountSetup as setup, callAccount as call, type FakeDb, type Outbox } from './account-fakes.ts';

describe('account status（登录页判断要不要显示恢复页；10-30 架构师）', () => {
  /** 任何一个 store 方法被调到就抛错：status 不该碰数据库 */
  const untouchable = new Proxy({}, { get: (_t, k) => () => { throw new Error(`store_${String(k)}_touched`); } }) as never;

  async function statusOf(db: FakeDb, box: Outbox[], over: Parameters<typeof accountDeps>[2] = {}) {
    const logs: string[] = [];
    const r = await call(db, box, { action: 'status' }, { store: untouchable, log: (c) => logs.push(c), ...over });
    expect(logs).toEqual([]);   // 没走到 catch（store 被碰会变成 db_error）
    return r;
  }

  it('正常账号：200 {ok, status: active}；不写 logs、不计次数、不发信、不碰 store', async () => {
    const { db, box } = setup();
    const r = await statusOf(db, box);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'active' });
    expect(accountStatusResponse.parse(b)).toEqual(b);
    expect(db.logs).toEqual([]);
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('冷静期（重新登录的新会话）：放行，200 {ok, status: pending_deletion, purge_after}；什么都不写', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    box.length = 0;
    db.sessions.set('aaaaaaaa-s9', A);
    const counters = new Map(db.counters);
    const r = await statusOf(db, box, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'pending_deletion', purge_after: db.pending.get(A)?.purge_after });
    expect(typeof (b as { purge_after: unknown }).purge_after).toBe('string');
    expect(accountStatusResponse.parse(b)).toEqual(b);
    expect(db.counters).toEqual(counters);
    expect(db.logs).toEqual([]);
    expect(box).toEqual([]);
    expect(db.pending.has(A)).toBe(true);
    // 别的动作照旧被拦（只有 restore、status 放行）
    const e = await call(db, box, { action: 'export', step: 'start' }, { session: 'aaaaaaaa-s9' });
    expect(await e.json()).toMatchObject({ error: 'account_pending_deletion' });
  });

  it('冷静期但取不到 pending_deletions 行：purge_after 为 null（不猜时刻）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    db.pending.delete(A);
    db.sessions.set('aaaaaaaa-s9', A);
    const b = await (await statusOf(db, box, { session: 'aaaaaaaa-s9' })).json();
    expect(b).toEqual({ ok: true, status: 'pending_deletion', purge_after: null });
    expect(accountStatusResponse.parse(b)).toEqual(b);
  });

  it('管理员停用、没有 profile：200 {ok, status: disabled}（不是 403）；冷静期里被管理员停用的也是 disabled', async () => {
    const { db, box } = setup();
    const p = db.profiles.get(A);
    if (!p) throw new Error('no profile');
    p.disabled_at = '2026-10-29T00:00:00.000Z';
    p.disabled_reason = 'admin';
    const r = await statusOf(db, box);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'disabled' });
    expect(accountStatusResponse.parse(b)).toEqual(b);
    db.profiles.delete(B);
    expect(await (await statusOf(db, box, { user: B })).json()).toEqual({ ok: true, status: 'disabled' });
    expect(db.logs).toEqual([]);
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('会话失效：照 requireActiveUser 原样回 401 session_revoked', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });   // 吊销全部会话
    const r = await statusOf(db, box);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'session_revoked' });
  });

  it('不占 export、delete 每天 3 次的额度：status 调多少次，导出照样能导 3 次', async () => {
    const { db, box } = setup();
    for (let i = 0; i < 10; i++) expect((await statusOf(db, box)).status).toBe(200);
    expect(db.counters.size).toBe(0);
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT; i++) expect((await call(db, box, { action: 'export', step: 'start' })).status).toBe(200);
    expect((await call(db, box, { action: 'export', step: 'start' })).status).toBe(429);
    expect(db.logs.map((l) => l.act)).toEqual(['export', 'export', 'export']);   // status 一条都没写
  });

  it('三种状态和 shared/schema/account.ts 的 ACCOUNT_STATUSES 一字不差', () => {
    expect([...ACCOUNT_STATUS_VALUES]).toEqual([...ACCOUNT_STATUSES]);
  });
});
