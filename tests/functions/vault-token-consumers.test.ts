// TC-B5-39（本批消费方：vault、vault-image、account export）：每个消费方各调五次坏令牌，按原因分码、不按消费方分（0.29 续第 94 条）：
// ① 不带 ② 签名改一个字节 ③ B 的令牌配 A 的会话 ④ 10 分 1 秒后 ⑤ pin_epoch 已变（reset / change_pin 之后）。①～④ vault_locked，⑤ vault_relock。
// 三个消费方都用真的 _shared/vault-token.ts（vaultTokenChecker），pin_epoch 从各自的假库读。另测：没配 VAULT_TOKEN_SECRET 时一律 vault_locked 并记日志。
import { describe, expect, it } from 'vitest';
import { signVaultToken, vaultTokenChecker } from '../../supabase/functions/_shared/vault-token.ts';
import { A as ACC_A, accountSetup } from './account-fakes.ts';
import { start } from './account-export-harness.ts';
import { imageWorld } from './vault-image-fakes.ts';
import { A, B, call, SECRET, T0, unlocked, world } from './vault-fakes.ts';

type Bad = '①' | '②' | '③' | '④' | '⑤';
const WANT: Record<Bad, string> = { '①': 'vault_locked', '②': 'vault_locked', '③': 'vault_locked', '④': 'vault_locked', '⑤': 'vault_relock' };
const flip = (t: string) => `${t.slice(0, -2)}${t.at(-2) === 'A' ? 'B' : 'A'}${t.at(-1)}`;

/** 五种坏令牌：now 是签发时刻；④ 的令牌在调用前要把时钟拨到 10 分 1 秒后，由调用方处理 */
async function badTokens(epochA: number, now: number): Promise<Record<Bad, string | null>> {
  const good = (await signVaultToken(SECRET, A, epochA, now)).token;
  return {
    '①': null, '②': flip(good), '③': (await signVaultToken(SECRET, B, 0, now)).token,
    '④': good, '⑤': (await signVaultToken(SECRET, A, epochA - 1, now)).token,
  };
}

describe('TC-B5-39：vault', () => {
  it('list 五种坏法', async () => {
    for (const bad of Object.keys(WANT) as Bad[]) {
      const w = world();
      await unlocked(w);
      await call(w, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, { token: (await signVaultToken(SECRET, A, 0, w.db.ms)).token });
      const toks = await badTokens(1, w.db.ms);
      if (bad === '④') w.db.ms += 601_000;
      const r = await call(w, { action: 'list' }, { token: toks[bad] });
      expect([r.status, r.body.error], bad).toEqual([401, WANT[bad]]);
    }
  });
});

describe('TC-B5-39：vault-image', () => {
  it('get、upload 五种坏法；不写 R2', async () => {
    for (const bad of Object.keys(WANT) as Bad[]) {
      const w = imageWorld(new Map([[A, 1], [B, 0]]));
      const toks = await badTokens(1, T0);
      if (bad === '④') w.advance(601_000);
      const g = await w.get({ action: 'get', image_id: '00000000-0000-4000-8000-000000000002' }, toks[bad]);
      const u = await w.upload(new Uint8Array(20), undefined, toks[bad]);
      for (const r of [g, u]) expect([r.status, ((await r.json()) as { error: string }).error], bad).toEqual([401, WANT[bad]]);
      expect(w.r2.puts).toEqual([]);
    }
  });
});

describe('TC-B5-39、46：account export', () => {
  it('start 五种坏法整个请求被拒，不建任务、不写 logs', async () => {
    expect(ACC_A).toBe(A);
    for (const bad of Object.keys(WANT) as Bad[]) {
      const { db, box } = accountSetup();
      let ms = db.clock.ms;
      const check = vaultTokenChecker(SECRET, () => ms, async (u) => (u === A ? 1 : u === B ? 0 : null));
      const toks = await badTokens(1, ms);
      if (bad === '④') ms += 601_000;
      const headers: Record<string, string> = toks[bad] === null ? {} : { 'x-vault-token': toks[bad] as string };
      const r = await start(db, box, {}, { verifyVaultToken: async (u, t) => (await check(u, t)).verdict }, headers);
      if (bad === '①') {
        expect(r.status, bad).toBe(200);   // 不带令牌照常导出（不放隐私记，TC-B5-45）
        continue;
      }
      expect([r.status, ((await r.json()) as { error: string }).error], bad).toEqual([401, WANT[bad]]);
      expect(db.logs.filter((l) => l.act === 'export'), bad).toEqual([]);
    }
  });

  it('没配 VAULT_TOKEN_SECRET：带令牌的一律 vault_locked，记 misconfigured:vault_token_secret', async () => {
    const logs: string[] = [];
    const check = vaultTokenChecker(null, () => T0, async () => 0, (c) => logs.push(c));
    expect((await check(A, 'anything')).verdict).toBe('vault_locked');
    expect(logs).toEqual(['misconfigured:vault_token_secret']);
  });
});
