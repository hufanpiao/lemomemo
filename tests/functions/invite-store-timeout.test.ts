// invite-signup、invite-admin 的 store 调用超时（接手清单 INVITE-store-timeout；_shared/store-timeout.ts 和两边的 store-timeout.ts）。
// 桩 store 在指定方法上永不返回，外面套和 index.ts 一样的 withStoreTimeouts，只把超时档换成几十毫秒。
// 重点：超时回包不泄露邀请码有没有效——start 在知道码有效以前超时，码有效、码不存在回的一样（try_later）；
//   知道码有效以后（全站额度、写 pending）超时回 {ok}，和码无效时一样。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_TIMEOUT_MS, StoreTimeout, storeTimer } from '../../supabase/functions/_shared/store-timeout.ts';
import { withStoreTimeouts as signupTimeouts } from '../../supabase/functions/invite-signup/store-timeout.ts';
import { withStoreTimeouts as adminTimeouts } from '../../supabase/functions/invite-admin/store-timeout.ts';
import type { Store } from '../../supabase/functions/invite-signup/core.ts';
import type { InviteStore } from '../../supabase/functions/invite-admin/core.ts';
import { call as signupCall, CODE, startBody, verifyBody, world, type World } from './invite-signup-harness.ts';
import { call as adminCall, FakeStore as AdminStore } from './invite-admin-fakes.ts';

const MS = 20;
const TRY_LATER = JSON.stringify({ error: 'try_later' });
const OK = JSON.stringify({ ok: true });
/** 格式对、库里没有的码 */
const NO_SUCH_CODE = 'QRST2345UVWX';

const SIGNUP_METHODS = ['takeRate', 'getInvite', 'claimInvite', 'releaseInvite', 'putPending', 'getPending', 'casPendingTries', 'deletePending', 'insertProfile', 'minClientVersion'] as const;
const ADMIN_METHODS = ['isAdmin', 'takeRate', 'insertInvite', 'listInvites', 'minClientVersion'] as const;

type Hang = (m: string, args: unknown[]) => boolean;

/** 按方法名转给 base；hang 命中的永不返回 */
function hanging<S>(base: S, names: readonly string[], hang: Hang): S {
  const b = base as object;
  return Object.fromEntries(names.map((m) => [m, (...a: unknown[]) => (hang(m, a) ? new Promise(() => {}) : Reflect.apply(Reflect.get(b, m) as (...x: unknown[]) => Promise<unknown>, base, a))])) as S;
}

/** invite-signup：store 换成套了超时的桩，日志收集 */
async function signupWorld(hang: Hang): Promise<World> {
  const w = await world();
  const raw = w.store;
  w.deps.store = signupTimeouts(() => hanging<Store>(raw, SIGNUP_METHODS, hang), { ms: MS, log: (c) => w.logs.push(c) });
  return w;
}

const isKey = (prefix: string): Hang => (m, a) => m === 'takeRate' && String(a[0]).startsWith(prefix);
const isM = (name: string): Hang => (m) => m === name;

afterEach(() => { vi.useRealTimers(); });

describe('_shared/store-timeout.ts', () => {
  it('默认 10 秒；永不返回时到点抛 StoreTimeout、abort 交下去的 signal；日志只有 store_timeout:<方法名>', async () => {
    expect(STORE_TIMEOUT_MS).toBe(10_000);
    const signals: AbortSignal[] = [];
    const logs: string[] = [];
    const t = storeTimer((s) => { signals.push(s); return { hang: () => new Promise<never>(() => {}) }; }, { ms: MS, log: (c) => logs.push(c) });
    const e = await t('getInvite', (s) => s.hang()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreTimeout);
    expect((e as StoreTimeout).method).toBe('getInvite');
    expect((e as Error).message).toBe('store_timeout');
    expect(signals[0]?.aborted).toBe(true);
    expect(logs).toEqual(['store_timeout:getInvite']);
  });

  it('成功、出错路径都清掉计时器，结果和错误原样传出', async () => {
    vi.useFakeTimers();
    const t = storeTimer(() => ({ ok: async () => 1, bad: async () => { throw new Error('db'); } }));
    expect(await t('ok', (s) => s.ok())).toBe(1);
    await expect(t('bad', (s) => s.bad())).rejects.toThrow('db');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('until：已过截止时刻不调底下、直接抛 StoreTimeout；剩余比 ms 短时按剩余算', async () => {
    let made = 0;
    const logs: string[] = [];
    const past = storeTimer(() => { made++; return { hang: () => new Promise<never>(() => {}) }; }, { ms: 10_000, until: Date.now() - 1, log: (c) => logs.push(c) });
    await expect(past('getPending', (s) => s.hang())).rejects.toBeInstanceOf(StoreTimeout);
    expect(made).toBe(0);
    expect(logs).toEqual(['store_timeout:getPending']);
    const t0 = Date.now();
    const soon = storeTimer(() => ({ hang: () => new Promise<never>(() => {}) }), { ms: 10_000, until: Date.now() + MS });
    await expect(soon('x', (s) => s.hang())).rejects.toBeInstanceOf(StoreTimeout);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('两边的包装包住了各自 store 的全部方法', async () => {
    const w = await world();
    expect(Object.keys(signupTimeouts(() => w.store)).sort()).toEqual([...SIGNUP_METHODS].sort());
    expect(Object.keys(adminTimeouts(() => new AdminStore() as InviteStore)).sort()).toEqual([...ADMIN_METHODS].sort());
  });
});

describe('invite-signup start 超时：不泄露码有没有效', () => {
  it.each([
    ['ip 限流', isKey('signup-ip:')],
    ['邮箱限流', isKey('signup-mail:')],
    ['读邀请码', isM('getInvite')],
  ])('%s 卡住（还不知道码有没有效）：有效码、不存在的码回包一字不差，都是 try_later；日志只有方法名', async (_n, hang) => {
    const a = await signupWorld(hang);
    const ra = await signupCall(a, startBody('a@example.com', CODE));
    const b = await signupWorld(hang);
    const rb = await signupCall(b, startBody('a@example.com', NO_SUCH_CODE));
    expect(ra).toEqual({ status: 503, text: TRY_LATER });
    expect(rb).toEqual(ra);
    expect(a.logs).toEqual([expect.stringMatching(/^store_timeout:(takeRate|getInvite)$/)]);
    expect(a.logs).toEqual(b.logs);
    expect(a.mails).toEqual([]);
  });

  it.each([
    ['全站额度', isKey('signup:global:')],
    ['写 pending', isM('putPending')],
  ])('%s 卡住（已知码有效）：回 {ok}，和码无效时一字不差；不发信；日志只有方法名、不记 db_error', async (_n, hang) => {
    const a = await signupWorld(hang);
    const ra = await signupCall(a, startBody('a@example.com', CODE));
    const b = await signupWorld(hang);
    const rb = await signupCall(b, startBody('a@example.com', NO_SUCH_CODE));
    expect(ra).toEqual({ status: 200, text: OK });
    expect(rb).toEqual(ra);
    expect(a.mails).toEqual([]);
    expect(a.logs).toEqual([expect.stringMatching(/^store_timeout:(takeRate|putPending)$/)]);
    expect(a.logs.join(' ')).not.toContain('db_error');
  });

  it('全站额度、写 pending 直接报错（不是超时）也回 {ok}，只记 db_error', async () => {
    const w = await world();
    const real = w.store.putPending.bind(w.store);
    w.store.putPending = async () => { throw new Error('db'); };
    expect(await signupCall(w, startBody('a@example.com'))).toEqual({ status: 200, text: OK });
    expect(w.logs).toEqual(['db_error']);
    expect(w.mails).toEqual([]);
    w.store.putPending = real;
  });

  it('版本门读配置卡住：放行（versionBlock 失败放行），照常发信', async () => {
    const w = await signupWorld(isM('minClientVersion'));
    expect(await signupCall(w, startBody('a@example.com'))).toEqual({ status: 200, text: OK });
    expect(w.mails).toHaveLength(1);
    expect(w.logs).toEqual(['store_timeout:minClientVersion']);
  });
});

describe('invite-signup verify 超时', () => {
  it.each(['getPending', 'casPendingTries', 'claimInvite'])('%s 卡住：try_later，不建用户，日志只有方法名', async (m) => {
    let armed = false;   // start 照常走完，verify 才开始卡
    const w = await signupWorld((x) => armed && x === m);
    expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    armed = true;
    w.logs.length = 0;
    const r = await signupCall(w, verifyBody('a@example.com'));
    expect(r).toEqual({ status: 503, text: TRY_LATER });
    expect(w.auth.users.size).toBe(0);
    expect(w.logs).toEqual([`store_timeout:${m}`]);
  });

  it('verify-ip 限流卡住：try_later，不读 pending、不建用户，日志只有 store_timeout:takeRate', async () => {
    let armed = false;
    const w = await signupWorld((m, a) => armed && isKey('signup-verify:')(m, a));
    expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    armed = true;
    w.logs.length = 0;
    expect(await signupCall(w, verifyBody('a@example.com'))).toEqual({ status: 503, text: TRY_LATER });
    expect(w.auth.users.size).toBe(0);
    expect(w.store.pending.size).toBe(1);
    expect(w.logs).toEqual(['store_timeout:takeRate']);
  });

  it('版本门读配置卡住：放行，注册照常成功', async () => {
    let armed = false;
    const w = await signupWorld((m) => armed && m === 'minClientVersion');
    expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    armed = true;
    w.logs.length = 0;
    const r = await signupCall(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toHaveProperty('token_hash');
    expect(w.logs).toEqual(['store_timeout:minClientVersion']);
  });

  it('注册成功后删 pending 卡住：注册照常成功，只记 store_timeout:deletePending 和 pending_delete_failed', async () => {
    let armed = false;
    const w = await signupWorld((m) => armed && m === 'deletePending');
    expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    armed = true;
    w.logs.length = 0;
    const r = await signupCall(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toHaveProperty('token_hash');
    expect(w.auth.users.size).toBe(1);
    expect(w.logs.sort()).toEqual(['pending_delete_failed', 'store_timeout:deletePending']);
  });

  it('建 profiles 卡住：删掉刚建的用户、退回邀请码，try_later', async () => {
    const w = await signupWorld(isM('insertProfile'));
    expect((await signupCall(w, startBody('a@example.com'))).status).toBe(200);
    const r = await signupCall(w, verifyBody('a@example.com'));
    expect(r).toEqual({ status: 503, text: TRY_LATER });
    expect(w.auth.users.size).toBe(0);
    expect([...w.store.invites.values()].every((x) => x.used_count === 0)).toBe(true);
    expect(w.logs).toEqual(expect.arrayContaining(['store_timeout:insertProfile', 'profile_failed']));
  });
});

describe('invite-admin 超时', () => {
  function adminStore(hang: Hang, logs: string[]) {
    const raw = new AdminStore();
    return { raw, store: adminTimeouts(() => hanging<InviteStore>(raw, ADMIN_METHODS, hang), { ms: MS, log: (c) => logs.push(c) }) };
  }

  it.each([
    ['isAdmin', { action: 'create' }],
    ['takeRate', { action: 'create' }],
    ['insertInvite', { action: 'create' }],
    ['listInvites', { action: 'list' }],
  ] as const)('%s 卡住：503 try_later，回包里没有码，日志只有方法名', async (m, body) => {
    const logs: string[] = [];
    const { raw, store } = adminStore(isM(m), logs);
    const { res, logs: fnLogs } = await adminCall(raw, body, { store, log: (c) => logs.push(c) });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(TRY_LATER);
    expect(logs).toEqual([`store_timeout:${m}`]);
    expect(fnLogs).toEqual([]);
  });

  it('版本门读配置卡住：放行，照常发码；日志只有 store_timeout:minClientVersion', async () => {
    const logs: string[] = [];
    const { raw, store } = adminStore(isM('minClientVersion'), logs);
    const { res } = await adminCall(raw, { action: 'create' }, { store, log: (c) => logs.push(c) });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('code');
    expect(raw.invites.size).toBe(1);
    expect(logs).toEqual(['store_timeout:minClientVersion']);
  });
});
