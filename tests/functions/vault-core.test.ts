// vault 函数：密码、锁定、重设、令牌、限流、出错（B5 任务单 S2、S3；TC-B5-01～05、16、39 vault 一半；架构 5.5）。
// 用 vault-fakes.ts 的内存假库；钥匙是测试专用假值。
import { describe, expect, it } from 'vitest';
import type { VaultRequest } from '../../shared/schema/vault.ts';
import type { VAULT_ERROR_CODES } from '../../shared/schema/vault.ts';
import { signVaultToken } from '../../supabase/functions/_shared/vault-token.ts';
import type { VaultErrCode, VaultReq } from '../../supabase/functions/vault/common.ts';
import { VAULT_RATE_PER_MIN } from '../../supabase/functions/vault/core.ts';
import { A, B, call, SECRET, unlocked, world } from './vault-fakes.ts';

// 双向类型核对：common.ts 手写的 VaultReq 和 schema 推出的 VaultRequest 一致（新增动作两边都得改）
type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
const sameReq: Same<VaultReq, VaultRequest> = true;
// 函数回的 vault 自己的码都在 schema 的表里（另有各函数共用的 bad_request、method_not_allowed）
type Own = Exclude<VaultErrCode, 'bad_request' | 'method_not_allowed'>;
const ownInSchema: Same<Own, (typeof VAULT_ERROR_CODES)[number]> = true;

describe('类型和 schema 一致', () => {
  it('VaultReq ⇔ vaultRequest、错误码 ⇔ VAULT_ERROR_CODES', () => {
    expect(sameReq && ownInSchema).toBe(true);
  });
});

describe('setup（TC-B5-01）', () => {
  it('3 位、13 位、带字母的拒；4 位、12 位成功；第二次 already_set', async () => {
    const w = world();
    for (const pin of ['123', '1234567890123', '12a4']) expect((await call(w, { action: 'setup', pin })).body.error).toBe('bad_pin');
    const ok = await call(w, { action: 'setup', pin: '1234' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.vault_token).toBe('string');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await call(w, { action: 'setup', pin: '5678' })).body.error).toBe('already_set');
    expect((await call(w, { action: 'setup', pin: '123456789012' }, { user: B })).status).toBe(200);
  });
});

describe('逐级锁定（TC-B5-02、03）', () => {
  it('连错 5 次锁 1 分钟，锁定中 unlock 回 423；到点后再错 5 次锁 5 分钟；输对清零', async () => {
    const w = world();
    await call(w, { action: 'setup', pin: '1234' });
    for (let i = 1; i <= 4; i++) {
      const r = await call(w, { action: 'unlock', pin: '0000' });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'pin_wrong', left: 5 - i });
    }
    const fifth = await call(w, { action: 'unlock', pin: '0000' });
    expect(fifth.body).toEqual({ error: 'pin_wrong', left: 0, retry_after_s: 60 });
    expect(w.pushes).toEqual([{ user: A, event: 'locked' }]);
    const during = await call(w, { action: 'unlock', pin: '1234' });   // 对的也不放
    expect(during.status).toBe(423);
    expect(during.body.error).toBe('pin_locked');
    w.db.ms += 61_000;
    for (let i = 0; i < 5; i++) await call(w, { action: 'unlock', pin: '0000' });
    expect((await call(w, { action: 'unlock', pin: '1234' })).body.retry_after_s).toBe(300);
    w.db.ms += 301_000;
    expect((await call(w, { action: 'unlock', pin: '1234' })).status).toBe(200);
    expect(w.db.s.vault.get(A)).toMatchObject({ fail_count: 0, lock_level: 0, locked_until: null });
  });

  it('格式不对不算一次失败；status 报锁到几时', async () => {
    const w = world();
    await call(w, { action: 'setup', pin: '1234' });
    expect((await call(w, { action: 'unlock', pin: 'abc' })).body.error).toBe('bad_pin');
    expect(w.db.s.vault.get(A)?.fail_count).toBe(0);
    for (let i = 0; i < 5; i++) await call(w, { action: 'unlock', pin: '0000' });
    const st = await call(w, { action: 'status' });
    expect(st.body).toMatchObject({ ok: true, set: true, locked_until: w.db.ms + 60_000, webauthn: 0 });
    expect(st.body.vault_token).toBeUndefined();
  });

  it('change_pin：不带令牌拒；旧密码错和 unlock 共用计数，5 次后 unlock 也锁', async () => {
    const w = world();
    const tok = await unlocked(w);
    expect((await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' })).body.error).toBe('vault_locked');
    await call(w, { action: 'unlock', pin: '0000' });
    for (let i = 0; i < 3; i++) await call(w, { action: 'change_pin', old_pin: '9999', new_pin: '5678' }, { token: tok });
    const last = await call(w, { action: 'change_pin', old_pin: '9999', new_pin: '5678' }, { token: tok });
    expect(last.body).toMatchObject({ error: 'pin_wrong', left: 0 });
    expect((await call(w, { action: 'unlock', pin: '1234' })).status).toBe(423);
  });
});

describe('reset 和 change_pin 之后（TC-B5-04、05、16）', () => {
  it('otp 9 分钟前成功、立即生效；11 分钟前、密码登录的回 reauth_required', async () => {
    const w = world();
    await call(w, { action: 'setup', pin: '1234' });
    expect((await call(w, { action: 'reset', new_pin: '5678' }, { otpAgoS: 11 * 60 })).body.error).toBe('reauth_required');
    expect((await call(w, { action: 'reset', new_pin: '5678' }, { otpAgoS: null })).body.error).toBe('reauth_required');
    const ok = await call(w, { action: 'reset', new_pin: '5678' }, { otpAgoS: 9 * 60 });
    expect(ok.status).toBe(200);
    expect((await call(w, { action: 'unlock', pin: '1234' })).status).toBe(403);
    expect((await call(w, { action: 'unlock', pin: '5678' })).status).toBe(200);
    // TC-B5-16：邮件、上次重设时间、logs 一条
    expect(w.mails).toEqual([w.db.ms]);
    expect(w.rows).toEqual([{ t: w.db.ms, act: 'vault_reset' }]);
    expect((await call(w, { action: 'status' })).body.last_reset_at).toBe(w.db.ms);
    expect(w.pushes.map((p) => p.event)).toEqual(['reset']);
  });

  it('旧令牌回 vault_relock；凭据、设备盐清空；pin_epoch 加 1（reset、change_pin 各一次）', async () => {
    const w = world();
    const old = await unlocked(w);
    w.db.s.creds.set('c1', { id: 'c1', user_id: A, public_key: new Uint8Array(65), sign_count: 0, label: null });
    w.db.s.secrets.set('d1', A);
    const ch = await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, { token: old });
    expect(ch.status).toBe(200);
    expect(w.db.s.vault.get(A)?.pin_epoch).toBe(1);
    expect(w.db.s.creds.size + w.db.s.secrets.size).toBe(0);
    expect((await call(w, { action: 'list' }, { token: old })).body.error).toBe('vault_relock');
    expect((await call(w, { action: 'list' }, { token: ch.body.vault_token as string })).status).toBe(200);
    const mid = ch.body.vault_token as string;
    await call(w, { action: 'reset', new_pin: '1111' });
    expect(w.db.s.vault.get(A)?.pin_epoch).toBe(2);
    expect((await call(w, { action: 'list' }, { token: mid })).body.error).toBe('vault_relock');
  });

  it('推送在事务提交以后才发：事务抛错（回滚）时攒下的推送整批丢掉；正常提交的照发', async () => {
    const w = world();
    const tok = await unlocked(w);
    const run = w.db.run.bind(w.db);
    let n = 0;
    w.deps.tx = (uid, fn) => run(uid, async (t) => {
      const r = await fn(t);
      if (++n === 1) throw new Error('commit');   // 验令牌和改密码在同一个事务里：做完了但提交失败
      return r;
    });
    expect((await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, { token: tok })).status).toBe(503);
    expect(w.pushes).toEqual([]);
    w.deps.tx = run;
    expect((await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, { token: tok })).status).toBe(200);
    expect(w.pushes.map((p) => p.event)).toEqual(['pin_changed']);
  });

  it('renew：只续期，回新令牌；不带令牌回 vault_locked', async () => {
    const w = world();
    const tok = await unlocked(w);
    const r = await call(w, { action: 'renew' }, { token: tok });
    expect(r.status).toBe(200);
    expect(typeof r.body.vault_token).toBe('string');
    expect((await call(w, { action: 'renew' })).body.error).toBe('vault_locked');
  });

  it('推送和发信失败不影响主流程，只记错误码', async () => {
    const w = world({ notify: async () => { throw new Error('x'); }, resetMail: async () => { throw new Error('x'); } });
    await call(w, { action: 'setup', pin: '1234' });
    expect((await call(w, { action: 'reset', new_pin: '5678' })).status).toBe(200);
    expect(w.logs).toEqual(expect.arrayContaining(['push_failed:reset', 'mail_failed:vault_reset']));
  });
});

describe('令牌（TC-B5-39 vault 一半）', () => {
  it('五种坏法：没带、签名改一个字节、B 的令牌、10 分 1 秒后、改密码后的旧令牌', async () => {
    const w = world();
    const tok = await unlocked(w);
    await unlocked(w, B);
    const bTok = (await signVaultToken(SECRET, B, 0, w.db.ms)).token;
    const flip = `${tok.slice(0, -2)}${tok.at(-2) === 'A' ? 'B' : 'A'}${tok.at(-1)}`;
    expect((await call(w, { action: 'list' })).body.error).toBe('vault_locked');
    expect((await call(w, { action: 'list' }, { token: flip })).body.error).toBe('vault_locked');
    expect((await call(w, { action: 'list' }, { token: bTok })).body.error).toBe('vault_locked');
    const late = world();
    const lt = await unlocked(late);
    late.db.ms += 601_000;
    expect((await call(late, { action: 'list' }, { token: lt })).body.error).toBe('vault_locked');
    await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, { token: tok });
    const r = await call(w, { action: 'list' }, { token: tok });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('vault_relock');
  });

  it('每次成功续期：新令牌的过期时刻是 10 分钟后', async () => {
    const w = world();
    const tok = await unlocked(w);
    w.db.ms += 300_000;
    const r = await call(w, { action: 'list' }, { token: tok });
    expect(r.body.expires_at).toBe(Math.floor(w.db.ms / 1000) * 1000 + 600_000);
  });
});

describe('入口', () => {
  it('非 POST 405；JSON 不对 400；超过 128 KB 413；每人每分钟 60 次', async () => {
    const w = world();
    const { handle } = await import('../../supabase/functions/vault/core.ts');
    expect((await handle(new Request('http://x', { method: 'GET' }), w.deps)).status).toBe(405);
    expect((await call(w, { action: 'nope' })).body.error).toBe('bad_request');
    expect((await call(w, { action: 'setup', pin: 'x'.repeat(140_000) })).status).toBe(413);
    // 上面 bad_request 那次也算（解析在限流之后）、413 那次不算（读请求体在鉴权之前）
    for (let i = 0; i < VAULT_RATE_PER_MIN - 1; i++) await call(w, { action: 'status' });
    expect((await call(w, { action: 'status' })).body.error).toBe('rate_limited');
    w.db.ms += 60_000;
    expect((await call(w, { action: 'status' })).status).toBe(200);
  });

  it('钥匙没配：status 照常，其余 503 try_later 并记 misconfigured；数据库出错 503 记 db_error', async () => {
    const w = world();
    w.deps.keys = { master: null, pepper: null, tokenSecret: null };
    expect((await call(w, { action: 'status' })).status).toBe(200);
    expect((await call(w, { action: 'setup', pin: '1234' })).body.error).toBe('try_later');
    expect(w.logs).toContain('misconfigured');
    const v = world();
    v.db.failNext = 'boom';
    expect((await call(v, { action: 'status' })).status).toBe(503);
    expect(v.logs).toContain('db_error');
  });

  it('日志里没有密码和令牌', async () => {
    const w = world();
    const tok = await unlocked(w, A, '987654');
    for (let i = 0; i < 5; i++) await call(w, { action: 'unlock', pin: '111111' });
    expect(w.logs.join('|')).not.toMatch(/987654|111111/);
    expect(w.logs.join('|')).not.toContain(tok);
  });
});

describe('账号停用（TC-B1-10）', () => {
  const deny = () => world({ async authenticate() { return { ok: false, response: new Response('{"error":"account_disabled"}', { status: 403 }) }; } });
  it('TC-B1-10 vault：管理员停用的账号回 403 account_disabled，不碰库', async () => {
    const w = deny();
    const r = await call(w, { action: 'unlock', pin: '1234' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('account_disabled');
    expect(w.rate.size).toBe(0);
  });
  it('TC-B1-10 vault：没有 profiles 行的账号回 403 account_disabled，不碰库', async () => {
    const w = deny();
    const r = await call(w, { action: 'setup', pin: '1234' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('account_disabled');
    expect(w.rate.size).toBe(0);
  });
});
