// 隐私记加密底座和令牌（B5 任务单 S1；TC-B5-17、TC-B5-39 的令牌五种坏法里 ①～④ 的纯函数一半，⑤ 由 loadEpoch 注入）。
// 钥匙全是测试专用的固定假值（只用于测试，不是任何环境的真钥匙）。
import { describe, expect, it } from 'vitest';
import { VAULT_TOKEN_TTL_S as SCHEMA_TTL, VAULT_UNLOCK_MAX_AGE_S as SCHEMA_MAX_AGE, lockSeconds } from '../../shared/schema/vault.ts';
import {
  aesKeyFor, decodeKey32, hexEqual, noteAad, open, openNote, pinHash, seal, sealNote,
} from '../../supabase/functions/_shared/vault-crypto.ts';
import { signVaultToken, VAULT_TOKEN_TTL_S, VAULT_UNLOCK_MAX_AGE_S, vaultTokenChecker } from '../../supabase/functions/_shared/vault-token.ts';

// 测试专用假钥匙（32 字节的 base64），只用于测试
const FAKE_MASTER_B64 = btoa('TEST-ONLY-fake-vault-key-32-byte');
const FAKE_SECRET_B64 = btoa('TEST-ONLY-fake-token-secret-32-b');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const N = '33333333-3333-4333-8333-333333333333';
const master = decodeKey32(FAKE_MASTER_B64)!;
const secret = decodeKey32(FAKE_SECRET_B64)!;

describe('decodeKey32', () => {
  it('只认正好 32 字节的标准 base64', () => {
    expect(master?.length).toBe(32);
    expect(decodeKey32(undefined)).toBeNull();
    expect(decodeKey32('')).toBeNull();
    expect(decodeKey32('c2hvcnQ=')).toBeNull();
    expect(decodeKey32(FAKE_MASTER_B64.replace('=', ''))).toBeNull();
    expect(decodeKey32(`${FAKE_MASTER_B64}AAAA`)).toBeNull();
  });
});

describe('子密钥和正文加密（TC-B5-17）', () => {
  it('同一个人同一用途能解开；AAD、用途、人任一不同都解不开', async () => {
    const kA = await aesKeyFor(master, A, 'note');
    const sealed = await sealNote(kA, A, N, '标题', '正文');
    expect(await openNote(kA, A, N, 1, sealed)).toEqual({ v: 1, title: '标题', body: '正文' });
    expect(await openNote(kA, A, N, 2, sealed)).toBeNull();                                  // enc_key_id 不同
    expect(await openNote(kA, A, B, 1, sealed)).toBeNull();                                  // note_id 不同
    expect(await openNote(await aesKeyFor(master, B, 'note'), A, N, 1, sealed)).toBeNull();   // 别人的子密钥
    expect(await openNote(await aesKeyFor(master, A, 'plus-draft'), A, N, 1, sealed)).toBeNull();   // 别的用途
  });
  it('AAD 换一个字节、密文改一个字节都解不开；每次 nonce 不同', async () => {
    const k = await aesKeyFor(master, A, 'note');
    const aad = noteAad(A, N, 1);
    const pt = new TextEncoder().encode('x');
    const s1 = await seal(k, aad, pt);
    const s2 = await seal(k, aad, pt);
    expect(s1.slice(0, 12)).not.toEqual(s2.slice(0, 12));
    expect(await open(k, `${aad.slice(0, -1)}2`, s1)).toBeNull();
    const bad = s1.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    expect(await open(k, aad, bad)).toBeNull();
    expect(await open(k, aad, s1.slice(0, 10))).toBeNull();
  });
});

describe('pin_hash', () => {
  it('同人同密码相同，换人或换密码不同；常数时间比较', async () => {
    const h1 = await pinHash(master, A, '1234');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await pinHash(master, A, '1234')).toBe(h1);
    expect(await pinHash(master, B, '1234')).not.toBe(h1);
    expect(await pinHash(master, A, '12345')).not.toBe(h1);
    expect(hexEqual(h1, h1)).toBe(true);
    expect(hexEqual(h1, h1.slice(0, -1))).toBe(false);
  });
});

describe('vault_token（TC-B5-39 ①～⑤）', () => {
  const now = 1_800_000_000_000;
  it('和 schema 的有效期一致；锁定阶梯 1、5、15、60、240 分钟之后一直 24 小时', () => {
    expect(VAULT_TOKEN_TTL_S).toBe(SCHEMA_TTL);
    expect([0, 1, 2, 3, 4, 5, 9].map(lockSeconds)).toEqual([60, 300, 900, 3600, 14400, 86400, 86400]);
  });
  /** 唯一的验法 vaultTokenChecker（整块评审第 19 条）：按 A 的会话、指定时刻、指定的 pin_epoch 读法验一次 */
  const verify = (token: string | null, at: number, ep: () => Promise<number | null>, sec: typeof secret = secret) =>
    vaultTokenChecker(sec, () => at, ep)(A, token);
  it('有效令牌通过；五种坏法按原因分码', async () => {
    const { token, expiresAt } = await signVaultToken(secret, A, 3, now);
    expect(expiresAt).toBe(Math.floor(now / 1000) * 1000 + 600_000);
    const ep = async () => 3;
    expect(await verify(token, now, ep)).toEqual({ verdict: 'ok', epoch: 3, firstAt: Math.floor(now / 1000) * 1000 });
    // ① 不带
    expect((await verify(null, now, ep)).verdict).toBe('vault_locked');
    expect((await verify('', now, ep)).verdict).toBe('vault_locked');
    // ② 签名改一个字节
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    expect((await verify(token.slice(0, -1) + last, now, ep)).verdict).toBe('vault_locked');
    // ③ B 的令牌配 A 的会话
    const tb = (await signVaultToken(secret, B, 3, now)).token;
    expect((await verify(tb, now, ep)).verdict).toBe('vault_locked');
    // ④ 10 分 1 秒后
    expect((await verify(token, now + 601_000, ep)).verdict).toBe('vault_locked');
    // ⑤ pin_epoch 已经变了
    expect((await verify(token, now, async () => 4)).verdict).toBe('vault_relock');
    // 没有 vault 行
    expect((await verify(token, now, async () => null)).verdict).toBe('vault_locked');
    // 换了 VAULT_TOKEN_SECRET
    expect((await verify(token, now, ep, master)).verdict).toBe('vault_locked');
  });
  it('格式不对的不查库', async () => {
    let called = 0;
    const ep = async () => { called++; return 0; };
    for (const t of ['v2.a.b', 'v1.a', 'x'.repeat(600), 'v1..']) expect((await verify(t, now, ep)).verdict).toBe('vault_locked');
    expect(called).toBe(0);
  });
  it('续期封顶 12 小时（主持人代定，整块评审第 22 条）：最早解锁时刻沿用，满 12 小时到点过期、不再往后续', async () => {
    expect(VAULT_UNLOCK_MAX_AGE_S).toBe(SCHEMA_MAX_AGE);
    const first = now;
    const ep = async () => 0;
    // 11 小时 55 分时续期：照常 10 分钟，firstAt 不变
    const t1 = now + (11 * 3600 + 55 * 60) * 1000;
    const r1 = await signVaultToken(secret, A, 0, t1, first);
    expect(r1.expiresAt).toBe(Math.floor(first / 1000) * 1000 + 43_200_000);   // 封顶：只能到 12 小时整
    expect(await verify(r1.token, t1, ep)).toEqual({ verdict: 'ok', epoch: 0, firstAt: Math.floor(first / 1000) * 1000 });
    // 到点以后：过期，回 vault_locked（要重新输密码或 Face ID）
    expect((await verify(r1.token, Math.floor(first / 1000) * 1000 + 43_200_000, ep)).verdict).toBe('vault_locked');
    // 12 小时以后再签也签不出能用的（x 不晚于 f + 12 小时，已经过了）
    const late = await signVaultToken(secret, A, 0, first + 43_300_000, first);
    expect((await verify(late.token, first + 43_300_000, ep)).verdict).toBe('vault_locked');
  });
});
