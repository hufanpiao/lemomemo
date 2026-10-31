// invite-signup verify：占码超时晚到提交（接手清单 INVITE-late-commit，迁移 20261031150000）和 Auth 管理接口超时（INVITE-auth-timeout）。
// 桩在指定方法上永不返回：'before' 不调底下（没做），'after' 底下照做再不返回（做了、回应丢了，模拟晚到提交），外面套和 index.ts 一样的超时包装。
import { describe, expect, it, vi } from 'vitest';
import { withAuthTimeouts, withStoreTimeouts } from '../../supabase/functions/invite-signup/store-timeout.ts';
import { type AuthAdmin, type Store } from '../../supabase/functions/invite-signup/core.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';
import {
  AUTH_METHODS, call, CODE, CODE2, handleStart, only, setup, startBody, STORE_METHODS, TRY_LATER, used, verifyBody, world,
} from './invite-signup-harness.ts';

describe('INVITE-late-commit：占码超时晚到提交', () => {
  it('占码超时但已提交：try_later；重试同一个验证码沿用，不再占，注册成功，used_count 只 +1', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('claimInvite', 'after'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(await used(w)).toBe(1);
    expect(w.logs).toContain('store_timeout:claimInvite');
    setHang(() => false);
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(await used(w)).toBe(1);
  });

  it('占上之后重新发码（换了验证码）再 verify：沿用这次占用，used_count 只 +1（协调方复核；用能发 3 次的 CODE2，一次性码占满后 start 不再发信）', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com', CODE2));
    setHang(only('claimInvite', 'after'));
    expect(await call(w, verifyBody('a@example.com', undefined, CODE2))).toEqual(TRY_LATER);
    expect(await used(w, CODE2)).toBe(1);
    setHang(() => false);
    w.deps.randomOtp = () => 654321;
    expect((await call(w, startBody('a@example.com', CODE2))).status).toBe(200);
    expect(await call(w, verifyBody('a@example.com', undefined, CODE2))).toMatchObject({ status: 400 });   // 旧验证码作废
    const r = await call(w, verifyBody('a@example.com', '654321', CODE2));
    expect(r.status).toBe(200);
    expect(await used(w, CODE2)).toBe(1);
  });

  it('一次性码占上（晚到提交）后点重新发码：占着它的正是这个邮箱，照常重发验证码；新验证码 verify 沿用占用、注册成功，used_count 只 +1', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('claimInvite', 'after'));
    await call(w, verifyBody('a@example.com'));
    setHang(() => false);
    const mails = w.mails.length;
    w.deps.randomOtp = () => 654321;
    expect(await call(w, startBody('a@example.com'))).toEqual({ status: 200, text: JSON.stringify({ ok: true }) });
    expect(w.mails.length).toBe(mails + 1);
    expect(w.mails.at(-1)?.text).toContain('654321');
    expect((await call(w, verifyBody('a@example.com', '654321'))).status).toBe(200);
    expect(await used(w)).toBe(1);
  });

  it('码已占满、占着它的是别的邮箱：start 照样回 {ok}，不发信（和码无效一样）；读 pending 出错也一样', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);   // a 用掉了 CODE
    const mails = w.mails.length;
    expect(await call(w, startBody('b@example.com'))).toEqual({ status: 200, text: JSON.stringify({ ok: true }) });
    setHang(only('getPending', 'before'));
    expect(await call(w, startBody('c@example.com'))).toEqual({ status: 200, text: JSON.stringify({ ok: true }) });
    expect(w.mails.length).toBe(mails);
  });

  it('占上之后换了另一个码重新发码再 verify：旧码退回、新码占上', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('claimInvite', 'after'));
    await call(w, verifyBody('a@example.com'));
    setHang(() => false);
    expect(await used(w, CODE)).toBe(1);
    await call(w, startBody('a@example.com', CODE2));
    expect((await call(w, verifyBody('a@example.com', undefined, CODE2))).status).toBe(200);
    expect(await used(w, CODE)).toBe(0);
    expect(await used(w, CODE2)).toBe(1);
  });

  it('退码幂等：email_exists 退过一次，再退不会减到别人的头上', async () => {
    const { w } = await setup();
    w.auth.users.set('a@example.com', 'bbbbbbbb-0000-4000-8000-000000000001');   // 别人早就注册
    await call(w, startBody('a@example.com'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual({ status: 409, text: JSON.stringify({ error: 'email_exists' }) });
    expect(await used(w)).toBe(0);
    const eh = [...w.store.pending.keys()][0];
    expect(eh).toBeUndefined();   // pending 也删了
    expect(await w.store.releaseInvite('x', await inviteCodeHash(CODE))).toBe(false);
    expect(await used(w)).toBe(0);
  });
});

describe('INVITE-auth-timeout：Auth 管理接口超时', () => {
  it('createUser 超时但已建出来：按派生 id 查得到，接着建 profile、注册成功；日志 auth_timeout:createUser', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('createUser', 'after'));
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(w.store.profiles.map((p) => p.userId)).toEqual([w.auth.ids[0]]);
    expect(await used(w)).toBe(1);
    expect(w.logs).toContain('auth_timeout:createUser');
  });

  it('createUser 超时、也没建出来：try_later，不退码、不删人，记 create_user_unknown；重试照常成功，used_count 只 +1', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('createUser', 'before'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(w.logs).toEqual(expect.arrayContaining(['auth_timeout:createUser', 'create_user_unknown']));
    expect(await used(w)).toBe(1);
    expect(w.auth.deleted).toEqual([]);
    setHang(() => false);
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);
    expect(await used(w)).toBe(1);
    expect(new Set(w.auth.ids).size).toBe(1);   // 两次用的是同一个 id
  });

  it('createUser、按 id 查都超时，而用户已晚到建出：try_later；重试时 createUser 回“已存在”，按 id 认领，注册成功', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang((m) => (m === 'createUser' ? 'after' : m === 'userExists' ? 'before' : false));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    setHang(() => false);
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toHaveProperty('token_hash');
    expect(await used(w)).toBe(1);
    expect(w.store.profiles).toHaveLength(1);
  });

  it('不泄露邮箱在不在：createUser 超时时，邮箱已被别人注册和没注册回包一字不差（都是 try_later）', async () => {
    const a = await setup();
    await call(a.w, startBody('a@example.com'));
    a.setHang(only('createUser', 'before'));
    const ra = await call(a.w, verifyBody('a@example.com'));
    const b = await setup();
    b.w.auth.users.set('a@example.com', 'bbbbbbbb-0000-4000-8000-000000000001');
    await call(b.w, startBody('a@example.com'));
    b.setHang(only('createUser', 'before'));
    const rb = await call(b.w, verifyBody('a@example.com'));
    expect(ra).toEqual(TRY_LATER);
    expect(rb).toEqual(ra);
    expect(a.w.logs).toEqual(b.w.logs);
  });

  it('createUser 回“已存在”而按 id 查出错：不能断定是别人，try_later、不退码（不回 email_exists）', async () => {
    const { w } = await setup();
    w.auth.users.set('a@example.com', 'bbbbbbbb-0000-4000-8000-000000000001');
    w.auth.failExists = true;
    await call(w, startBody('a@example.com'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(await used(w)).toBe(1);
  });

  it('建 profile 失败、deleteUser 超时：按没删成处理，不退码、记 orphan_user；重试时认领这个用户补上 profile，注册成功', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    w.store.failProfile = true;
    setHang(only('deleteUser', 'before'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(w.logs).toEqual(expect.arrayContaining(['profile_failed', 'auth_timeout:deleteUser', `orphan_user:${w.auth.ids[0]?.slice(0, 8)}`]));
    expect(await used(w)).toBe(1);
    w.store.failProfile = false;
    setHang(() => false);
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);
    expect(w.store.profiles).toHaveLength(1);
    expect(await used(w)).toBe(1);
  });

  it('安全审查 N1：按 id 认领来的用户补 profile 失败：不调 deleteUser、不退码，只回 try_later', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('createUser', 'after'));   // 超时但已建出 → 认领
    w.store.failProfile = true;
    const del: string[] = [];
    const rel: string[] = [];
    const realDel = w.auth.deleteUser.bind(w.auth);
    const realRel = w.store.releaseInvite.bind(w.store);
    w.auth.deleteUser = async (id) => { del.push(id); return realDel(id); };
    w.store.releaseInvite = async (eh, h) => { rel.push(h); return realRel(eh, h); };
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(del).toEqual([]);
    expect(rel).toEqual([]);
    expect(await used(w)).toBe(1);
    expect(w.auth.users.size).toBe(1);
    expect(w.logs).toContain('profile_failed');
    expect(w.logs.some((l) => l.startsWith('orphan_user:'))).toBe(false);
  });

  it('安全审查 N1：上一次全成功但删 pending 失败，再 verify 认领到在用账号、补 profile 失败：不删账号、不退码', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('deletePending', 'before'));
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);
    setHang(() => false);
    w.store.failProfile = true;
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);
    expect(w.auth.deleted).toEqual([]);
    expect(w.auth.users.size).toBe(1);
    expect(await used(w)).toBe(1);
  });

  it('代码审查增量复核 1：createUser 超时晚到建出 → 点重新发码（同一个码）→ 新验证码 verify：按派生 id 认领，注册成功，不记 orphan_suspect', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang((m) => (m === 'createUser' ? 'after' : m === 'userExists' ? 'before' : false));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);   // 晚到建出，这一次认不出
    expect(w.auth.users.size).toBe(1);
    setHang(() => false);
    w.deps.randomOtp = () => 654321;
    expect((await call(w, startBody('a@example.com'))).status).toBe(200);    // 一次性码由本邮箱占着：照常重发
    expect(w.mails).toHaveLength(2);
    const r = await call(w, verifyBody('a@example.com', '654321'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toHaveProperty('token_hash');
    expect(w.logs).not.toContain('orphan_suspect');
    expect(w.auth.users.size).toBe(1);
    expect(new Set(w.auth.ids).size).toBe(1);   // 两版验证码派生的是同一个 id
    expect(w.store.profiles).toHaveLength(1);
    expect(await used(w)).toBe(1);
  });

  it('同一邮箱用同一个多次码再注册、撞上自己已注册完的账号：认领到但 profile 早有 → 409 email_exists，这次新占的退回，不签 magiclink', async () => {
    const { w } = await setup();
    await call(w, startBody('a@example.com', CODE2));
    expect((await call(w, verifyBody('a@example.com', undefined, CODE2))).status).toBe(200);
    expect(await used(w, CODE2)).toBe(1);
    expect((await call(w, startBody('a@example.com', CODE2))).status).toBe(200);
    let links = 0;
    const realLink = w.auth.magiclinkTokenHash.bind(w.auth);
    w.auth.magiclinkTokenHash = async (e) => { links++; return realLink(e); };
    expect(await call(w, verifyBody('a@example.com', undefined, CODE2))).toEqual({ status: 409, text: JSON.stringify({ error: 'email_exists' }) });
    expect(links).toBe(0);
    expect(await used(w, CODE2)).toBe(1);
    expect(w.auth.users.size).toBe(1);
    expect(w.auth.deleted).toEqual([]);
  });

  it('上一次全成功但删 pending 失败，同一个验证码再 verify（claim 回 reused）：profile 早有 → 409 email_exists，不退码（那一次属于成功的注册）', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('deletePending', 'before'));
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);
    setHang(() => false);
    expect(await call(w, verifyBody('a@example.com'))).toEqual({ status: 409, text: JSON.stringify({ error: 'email_exists' }) });
    expect(await used(w)).toBe(1);
    expect(w.auth.deleted).toEqual([]);
  });

  it('代码审查 ②：createUser 超时晚到建出后换码重新发码，新验证码 verify 撞上“已存在”：不回 email_exists、不退码，记 orphan_suspect', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang((m) => (m === 'createUser' ? 'after' : m === 'userExists' ? 'before' : false));
    expect(await call(w, verifyBody('a@example.com'))).toEqual(TRY_LATER);   // U1 晚到建出
    setHang(() => false);
    w.deps.randomOtp = () => 654321;
    expect((await call(w, startBody('a@example.com', CODE2))).status).toBe(200);
    w.logs.length = 0;
    const r = await call(w, verifyBody('a@example.com', '654321', CODE2));
    expect(r).toEqual(TRY_LATER);
    expect(w.logs).toContain('orphan_suspect');
    expect(w.logs.join(' ')).not.toMatch(/@|[0-9a-f]{8}-/);
    // 旧码 CODE 在换码时退回，新码 CODE2 占着、没退：合起来只占一次
    expect((await used(w, CODE)) ?? 0).toBe(0);
    expect(await used(w, CODE2)).toBe(1);
  });

  it('user_id_mismatch：Auth 没按给的 id 建（回了别的 id）：记 user_id_mismatch，照用它回的 id，注册照常成功', async () => {
    const { w } = await setup();
    await call(w, startBody('a@example.com'));
    const real = w.auth.createUser.bind(w.auth);
    const OTHER = 'eeeeeeee-0000-4000-8000-0000000000ee';
    w.auth.createUser = async (_id, email, locale) => real(OTHER, email, locale);
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(200);
    expect(w.logs).toContain('user_id_mismatch');
    expect(w.store.profiles.map((p) => p.userId)).toEqual([OTHER]);
    expect(await used(w)).toBe(1);
  });

  it('整次请求预算（代码审查 (a)）：每步都慢，预算用完后不再调底下、直接 try_later；不依赖真实时钟', async () => {
    const w = await world();
    const log = (c: string) => w.logs.push(c);
    await handleStart(w);
    const SLOW = 15;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: string[] = [];
    const slow = <S,>(base: S, names: readonly string[]): S => Object.fromEntries(names.map((m) => [m, async (...a: unknown[]) => {
      calls.push(m);
      await new Promise((r) => setTimeout(r, SLOW));
      return Reflect.apply(Reflect.get(base as object, m) as (...x: unknown[]) => Promise<unknown>, base, a);
    }])) as S;
    const until = Date.now() + 50;
    w.deps.store = withStoreTimeouts(() => slow<Store>(w.store, STORE_METHODS), { ms: 1000, log, until });
    w.deps.auth = withAuthTimeouts(slow<AuthAdmin>(w.auth, AUTH_METHODS), { ms: 1000, log, until });
    // 假时钟（代码审查增量复核 3）：不量真实耗时。哈希走真线程池，所以每推进一步假时间都先让出一次真事件循环，直到请求结束
    let done = false;
    const pending = call(w, verifyBody('a@example.com')).finally(() => { done = true; });
    try {
      for (let i = 0; !done && i < 1000; i++) {
        await new Promise((res) => setImmediate(res));
        await vi.advanceTimersByTimeAsync(5);
      }
    } finally {
      vi.useRealTimers();
    }
    const r = await pending;
    expect(r).toEqual(TRY_LATER);
    expect(w.logs.some((l) => /^(store|auth)_timeout:/.test(l))).toBe(true);
    expect(calls.length).toBeLessThan(STORE_METHODS.length);   // 没把后面的步骤都走一遍
  });

  it('magiclink 生成超时：502 link_failed（账号已建好，客户端改走发登录验证码），日志 auth_timeout:magiclinkTokenHash', async () => {
    const { w, setHang } = await setup();
    await call(w, startBody('a@example.com'));
    setHang(only('magiclinkTokenHash', 'before'));
    expect(await call(w, verifyBody('a@example.com'))).toEqual({ status: 502, text: JSON.stringify({ error: 'link_failed' }) });
    expect(w.logs).toEqual(expect.arrayContaining(['auth_timeout:magiclinkTokenHash', 'link_failed']));
    expect(w.store.profiles).toHaveLength(1);
  });
});
