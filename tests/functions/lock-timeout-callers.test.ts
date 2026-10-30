// 等锁超时（55P03 lock_not_available）时各调用方的处理（接手清单 LOCK-timeout-fn；迁移 20261031130000_core_fn_lock_timeout.sql）。
// 四个函数带函数级 lock_timeout = 5s：等锁超时整句回滚、什么都没写，supabase-js 回 error，index.ts 的 must() 和各错误分支抛普通 Error
// （55P03 不在 export_job_exists、23505、RPC_CODES 的映射里）。这里在 store 一层模拟“没写进去就报错”，
// 核对 account、invite-signup、invite-admin 都回 503 try_later、日志只记 db_error，计数不误扣、不误退。
import { describe, expect, it } from 'vitest';
import { type AccountStore, keys } from '../../supabase/functions/account/core.ts';
import { keys as adminKeys } from '../../supabase/functions/invite-admin/core.ts';
import { A, accountSetup, callAccount, type FakeDb } from './account-fakes.ts';
import { part, start } from './account-export-harness.ts';
import { call as adminCall, FakeStore as AdminStore } from './invite-admin-fakes.ts';
import { call as signupCall, startBody, verifyBody, world } from './invite-signup-harness.ts';

const EID = 'eeeeeeee-0000-4000-8000-0000000000e1';
const TRY_LATER = JSON.stringify({ error: 'try_later' });

/** 和 supabase-js 回的 error 一样带 code；内容里不带任何键、参数 */
function lockErr(): Error {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

type Pick = (m: string, args: unknown[]) => boolean;
const rpc = (name: string): Pick => (m) => m === name;
const rate = (prefix: string): Pick => (m, a) => m === 'takeRate' && String(a[0]).startsWith(prefix);

/** pick 命中的调用不碰底下（事务回滚，等于没写），直接抛 55P03；calls 记下每次调用的方法名 */
function lockingStore(db: FakeDb, pick: Pick, calls: string[]): AccountStore {
  const base = db.accountStore() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return Object.fromEntries(Object.entries(base).map(([m, fn]) => [m, async (...a: unknown[]) => {
    calls.push(m);
    if (pick(m, a)) throw lockErr();
    return fn(...a);
  }])) as unknown as AccountStore;
}

function setup(pick: Pick) {
  const { db, box } = accountSetup();
  const logs: string[] = [];
  const calls: string[] = [];
  const over = { store: lockingStore(db, pick, calls), log: (c: string) => logs.push(c), newId: () => EID };
  return { db, box, logs, calls, over };
}

const jobRows = (db: FakeDb) => [...db.counters.keys()].filter((k) => k.startsWith('export-job:'));

async function expectTryLater(r: Response) {
  expect(r.status).toBe(503);
  expect(await r.text()).toBe(TRY_LATER);
}

describe('account export start：55P03', () => {
  it('take_rate（account 当天次数）等锁超时：try_later，没扣上，不调退回、不建任务', async () => {
    const t = setup(rate('account:'));
    await expectTryLater(await start(t.db, t.box, {}, t.over));
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
    expect(t.calls).not.toContain('refundRate');
    expect(t.calls).not.toContain('exportJobStart');
    expect(t.logs).toEqual(['db_error']);
  });

  it('take_rate（export-size 预检次数）等锁超时：try_later，当天次数没动', async () => {
    const t = setup(rate('export-size:'));
    await expectTryLater(await start(t.db, t.box, {}, t.over));
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
    expect(t.calls).not.toContain('exportJobStart');
  });

  it('export_job_start 等锁超时：try_later，当天次数退回、export-refund +1，没有任务行、没有 export 记录', async () => {
    const t = setup(rpc('exportJobStart'));
    await expectTryLater(await start(t.db, t.box, {}, t.over));
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
    expect(t.db.count(keys.exportRefund(A, t.db.clock.ms))).toBe(1);
    expect(jobRows(t.db)).toEqual([]);
    expect(t.db.logs.filter((l) => l.act === 'export')).toEqual([]);
    expect(t.box).toEqual([]);
  });

  it('export_job_start 和退回前的 take_rate（export-refund）都等锁超时：try_later，按“不退”记 export_refund_failed，不误退', async () => {
    const t = setup((m, a) => rpc('exportJobStart')(m, a) || rate('export-refund:')(m, a));
    await expectTryLater(await start(t.db, t.box, {}, t.over));
    expect(t.calls).not.toContain('refundRate');
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(1);
    expect(t.db.count(keys.exportRefund(A, t.db.clock.ms))).toBe(0);
    expect(jobRows(t.db)).toEqual([]);
    expect(t.logs).toContain('export_refund_failed');
  });
});

describe('account export part：55P03', () => {
  async function started(db: FakeDb, box: Parameters<typeof start>[1]) {
    expect((await start(db, box, {}, { newId: () => EID })).status).toBe(200);
  }

  it('take_rate（export-part）等锁超时：try_later，分片数没加上；放开后照常取到', async () => {
    const t = setup(rate('export-part:'));
    await started(t.db, t.box);
    await expectTryLater(await part(t.db, t.box, EID, null, t.over));
    expect(t.db.count(keys.exportPart(A, t.db.clock.ms))).toBe(0);
    expect(t.calls).not.toContain('exportJobTake');
    expect((await part(t.db, t.box, EID, null, { log: () => {} })).status).toBe(200);
  });

  it('export_job_take 等锁超时：try_later，任务的已取片数不变、不读数据；放开后同一游标照常取到', async () => {
    const t = setup(rpc('exportJobTake'));
    await started(t.db, t.box);
    const before = jobRows(t.db).map((k) => [k, t.db.counters.get(k)]);
    await expectTryLater(await part(t.db, t.box, EID, null, t.over));
    expect(jobRows(t.db).map((k) => [k, t.db.counters.get(k)])).toEqual(before);
    expect(t.db.pageReads).toEqual([]);
    expect(t.logs).toEqual(['db_error']);
    expect((await part(t.db, t.box, EID, null, { log: () => {} })).status).toBe(200);
  });
});

describe('account delete、restore：55P03', () => {
  it('account_request_deletion 等锁超时：try_later，注销没生效（没有 pending 行、会话没吊销），当天次数不退（0.47 第 22 条同口径）', async () => {
    const t = setup(rpc('requestDeletion'));
    await expectTryLater(await callAccount(t.db, t.box, { action: 'delete', confirm: '注销' }, t.over));
    expect(t.db.pending.has(A)).toBe(false);
    expect(t.db.revoked.size).toBe(0);
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(1);
    expect(t.calls).not.toContain('refundRate');
    expect(t.box).toEqual([]);
  });

  it('take_rate（account）在 delete 里等锁超时：try_later，不调注销', async () => {
    const t = setup(rate('account:'));
    await expectTryLater(await callAccount(t.db, t.box, { action: 'delete', confirm: '注销' }, t.over));
    expect(t.calls).not.toContain('requestDeletion');
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
  });

  it('take_rate（restore）等锁超时：try_later，不调恢复、次数没扣', async () => {
    const t = setup(rate('restore:'));
    t.db.requestDeletion(A);
    const s = [...t.db.revoked.keys()];
    for (const id of s) { t.db.revoked.delete(id); t.db.sessions.set(id, A); }   // 冷静期里重新登录
    await expectTryLater(await callAccount(t.db, t.box, { action: 'restore' }, t.over));
    expect(t.calls).not.toContain('restore');
    expect(t.db.count(keys.restore(A, t.db.clock.ms))).toBe(0);
    expect(t.db.pending.has(A)).toBe(true);
  });

  it('account_restore 等锁超时（LOCK-restore，迁移 20261031140000）：try_later，还在冷静期里（pending 行在、没恢复），restore 当天次数不退', async () => {
    const t = setup(rpc('restore'));
    t.db.requestDeletion(A);
    for (const id of [...t.db.revoked.keys()]) { t.db.revoked.delete(id); t.db.sessions.set(id, A); }
    await expectTryLater(await callAccount(t.db, t.box, { action: 'restore' }, t.over));
    expect(t.db.pending.has(A)).toBe(true);
    expect(t.db.profiles.get(A)?.disabled_at).not.toBeNull();
    expect(t.db.count(keys.restore(A, t.db.clock.ms))).toBe(1);
    expect(t.calls).not.toContain('refundRate');
    expect(t.logs).toEqual(['db_error']);
    expect(t.box).toEqual([]);
  });
});

describe('invite-signup、invite-admin：take_rate 55P03', () => {
  it.each([
    ['start 第 1 道（ip）', 'start', 0, 503],
    ['start 第 2 道（mail）', 'start', 1, 503],
    // 第 3 道在码有效之后：回 {ok}，和码无效一样，不泄露码对不对（INVITE-store-timeout）
    ['start 第 3 道（global）', 'start', 2, 200],
    ['verify（verify-ip）', 'verify', 0, 503],
  ] as const)('invite-signup %s 等锁超时：回 %i（503 是 try_later），日志只有 db_error，不发信、邀请码没占用', async (_n, step, nth, status) => {
    const w = await world();
    if (step === 'verify') expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    const mailsBefore = w.mails.length;
    w.logs.length = 0;
    const real = w.store.takeRate.bind(w.store);
    let i = 0;
    w.store.takeRate = async (k: string, l: number) => { if (i++ === nth) throw lockErr(); return real(k, l); };
    const r = await signupCall(w, step === 'start' ? startBody('b@example.com') : verifyBody('a@example.com'));
    expect(r).toEqual(status === 503 ? { status, text: TRY_LATER } : { status, text: JSON.stringify({ ok: true }) });
    expect(w.logs).toEqual(['db_error']);
    expect(w.mails.length).toBe(mailsBefore);
    expect([...w.store.invites.values()].every((x) => x.used_count === 0)).toBe(true);
    expect(i).toBe(nth + 1);
  });

  it('invite-admin create 等锁超时：503 try_later，没发出码、日志只有 db_error', async () => {
    const store = new AdminStore();
    const real = store.takeRate.bind(store);
    store.takeRate = async (k: string, l: number) => { if (k.startsWith('invite-admin:')) throw lockErr(); return real(k, l); };
    const { res, logs } = await adminCall(store, { action: 'create' });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(TRY_LATER);
    expect(logs).toEqual(['db_error']);
    expect(store.invites.size).toBe(0);
    expect(store.calls).not.toContain('insertInvite');
    expect(adminKeys.create('x', 0).startsWith('invite-admin:')).toBe(true);
  });
});
