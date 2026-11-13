// 隐私记令牌 vault_token（架构 5.5、6.2 A2、0.29 续第 94 条；B5 任务单 S1）：vault 签发和验，vault-image、account export 只验，
// 以后 vault-file、note-search、ai-summarize、ai-parse / ai-voice 的 scope=vault 也调这一份（TC-B5-39 按消费方清单逐个测）。
// • 内容：user_id + pin_epoch + 过期时刻（秒）；HMAC-SHA256(VAULT_TOKEN_SECRET)。写法 v1.<base64url(JSON)>.<base64url(MAC)>，MAC 盖 'v1.' + 中段。
// • 有效 10 分钟，每次调用由 vault 续期（重签一张）。VAULT_TOKEN_SECRET 丢了重新生成即可（R-220：只是所有人要重新解锁）。
// • 验：先验格式和 MAC（常数时间）、user_id 等于 JWT 的、没过期——任一不过回 vault_locked；再查库里当前 pin_epoch，
//   不一致回 vault_relock；库里没有这个人的 vault 行回 vault_locked（按原因分码、不按消费方分，0.29 续第 94 条）。
// • 查 pin_epoch 由调用方注入（vault、account 用 fn_vault，vault-image 等用 fn_ai，6.2 A2），这里不连库。
// 不打印令牌、不抛带内容的错误；不 import npm 包、不碰 Deno 全局（Vitest 直接测）。
import { b64uDecode, b64uEncode } from './b64url.ts';

export const VAULT_TOKEN_TTL_S = 600;   // 和 shared/schema/vault.ts 的同名常量一致（tests/functions/vault-token.test.ts 核对）
const MAX_TOKEN_LEN = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

export type VaultTokenVerdict = 'ok' | 'vault_locked' | 'vault_relock';

async function mac(secret: Bytes, msg: string): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** 签一张令牌；expiresAt 是毫秒 */
export async function signVaultToken(secret: Bytes, userId: string, pinEpoch: number, nowMs: number): Promise<{ token: string; expiresAt: number }> {
  const x = Math.floor(nowMs / 1000) + VAULT_TOKEN_TTL_S;
  const mid = b64uEncode(enc.encode(JSON.stringify({ u: userId, e: pinEpoch, x })));
  const head = `v1.${mid}`;
  return { token: `${head}.${b64uEncode(await mac(secret, head))}`, expiresAt: x * 1000 };
}

type Parsed = { u: string; e: number; x: number };

/** 只验格式、MAC、user_id、过期；过了回令牌里的 pin_epoch，不过回 null */
export async function checkVaultTokenSig(secret: Bytes, jwtUserId: string, token: string | null | undefined, nowMs: number): Promise<number | null> {
  if (!token || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, mid, sig] = parts as [string, string, string];
  const got = b64uDecode(sig);
  if (!got || got.length !== 32) return null;
  const want = await mac(secret, `v1.${mid}`);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (want[i] ?? 0) ^ (got[i] ?? 0);
  if (diff !== 0) return null;
  let p: Partial<Parsed>;
  try {
    const raw = b64uDecode(mid);
    if (!raw) return null;
    p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as Partial<Parsed>;
  } catch {
    return null;
  }
  if (typeof p.u !== 'string' || !UUID.test(p.u) || p.u !== jwtUserId) return null;
  if (typeof p.e !== 'number' || !Number.isSafeInteger(p.e) || p.e < 0) return null;
  if (typeof p.x !== 'number' || !Number.isSafeInteger(p.x) || p.x * 1000 <= nowMs) return null;
  return p.e;
}

/**
 * 完整验一次：loadEpoch 读这个人当前的 pin_epoch（没有 vault 行回 null）；出错就让它抛（调用方回 try_later），不当成通过。
 * 回 'ok' 时 epoch 是当前值（vault 拿它续期）。
 */
export async function verifyVaultToken(
  secret: Bytes, jwtUserId: string, token: string | null | undefined, nowMs: number, loadEpoch: () => Promise<number | null>,
): Promise<{ verdict: VaultTokenVerdict; epoch?: number }> {
  const e = await checkVaultTokenSig(secret, jwtUserId, token, nowMs);
  if (e === null) return { verdict: 'vault_locked' };
  const cur = await loadEpoch();
  if (cur === null) return { verdict: 'vault_locked' };
  if (cur !== e) return { verdict: 'vault_relock' };
  return { verdict: 'ok', epoch: cur };
}
