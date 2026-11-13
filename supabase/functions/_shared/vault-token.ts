// 隐私记令牌 vault_token（架构 5.5、6.2 A2、0.29 续第 94 条；B5 任务单 S1）：vault 签发和验，vault-image、account export 只验，
// 以后 vault-file、note-search、ai-summarize、ai-parse / ai-voice 的 scope=vault 也调这一份（TC-B5-39 按消费方清单逐个测）。
// • 内容：user_id + pin_epoch + 过期时刻 x + 这一串续期最早那次解锁的时刻 f（都是秒）；HMAC-SHA256(VAULT_TOKEN_SECRET)。
//   写法 v1.<base64url(JSON{u,e,x,f})>.<base64url(MAC)>，MAC 盖 'v1.' + 中段。
// • 有效 10 分钟，每次调用由 vault 续期（重签一张，f 不变）；输密码、Face ID、设密码、重设时 f = 现在。
//   续期封顶（11-14 主持人代定，整块评审第 22 条）：x 最晚到 f + VAULT_UNLOCK_MAX_AGE_S（12 小时），到点令牌自然过期回 vault_locked，要重新解锁；
//   不绑 session_id。VAULT_TOKEN_SECRET 丢了重新生成即可（R-220：只是所有人要重新解锁）。
// • 验：先验格式和 MAC（常数时间）、user_id 等于 JWT 的、没过期、x 不超过 f + 12 小时——任一不过回 vault_locked；再查库里当前 pin_epoch，
//   不一致回 vault_relock；库里没有这个人的 vault 行回 vault_locked（按原因分码、不按消费方分，0.29 续第 94 条）。
// • 只有 vaultTokenChecker 一个验法入口（整块评审第 19 条）；查 pin_epoch 由调用方注入（vault、account 用 fn_vault，vault-image 等用 fn_ai，6.2 A2），这里不连库。
// 不打印令牌、不抛带内容的错误；不 import npm 包、不碰 Deno 全局（Vitest 直接测）。
import { b64uDecode, b64uEncode } from './b64url.ts';

export const VAULT_TOKEN_TTL_S = 600;   // 和 shared/schema/vault.ts 的同名常量一致（tests/shared/vault-parity.test.ts 核对）
export const VAULT_UNLOCK_MAX_AGE_S = 43200;   // 同上（12 小时）
/** 请求头名：vault、vault-image、account 导出都从这里取（和前端 src/core/vault-token.ts 的同名常量一致，tests/shared/vault-parity.test.ts 核对） */
export const VAULT_TOKEN_HEADER = 'x-vault-token';
/** 令牌最长多少字符（签出来的约 150 个）；消费方先按它挡超长，再验签名 */
export const VAULT_TOKEN_MAX_LEN = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

export type VaultTokenVerdict = 'ok' | 'vault_locked' | 'vault_relock';

async function mac(secret: Bytes, msg: string): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** 签一张令牌；expiresAt 是毫秒。firstMs：这一串续期最早那次解锁的时刻（新解锁就是 nowMs） */
export async function signVaultToken(
  secret: Bytes, userId: string, pinEpoch: number, nowMs: number, firstMs: number = nowMs,
): Promise<{ token: string; expiresAt: number }> {
  const f = Math.floor(firstMs / 1000);
  const x = Math.min(Math.floor(nowMs / 1000) + VAULT_TOKEN_TTL_S, f + VAULT_UNLOCK_MAX_AGE_S);
  const mid = b64uEncode(enc.encode(JSON.stringify({ u: userId, e: pinEpoch, x, f })));
  const head = `v1.${mid}`;
  return { token: `${head}.${b64uEncode(await mac(secret, head))}`, expiresAt: x * 1000 };
}

type Parsed = { u: string; e: number; x: number; f: number };
/** 验过的令牌：pin_epoch 和最早解锁时刻（毫秒） */
type Sig = { epoch: number; firstAt: number };
const secs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** 只验格式、MAC、user_id、过期和 12 小时封顶；过了回令牌里的 pin_epoch 和 f，不过回 null */
async function checkSig(secret: Bytes, jwtUserId: string, token: string | null | undefined, nowMs: number): Promise<Sig | null> {
  if (!token || token.length > VAULT_TOKEN_MAX_LEN) return null;
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
  if (!secs(p.e) || !secs(p.x) || !secs(p.f)) return null;
  if (p.x * 1000 <= nowMs || p.x > p.f + VAULT_UNLOCK_MAX_AGE_S) return null;
  return { epoch: p.e, firstAt: p.f * 1000 };
}

export type VaultTokenCheck = { verdict: VaultTokenVerdict; epoch?: number; firstAt?: number };

/**
 * 消费方（vault、vault-image、account export）共用的唯一验法：secret 是 VAULT_TOKEN_SECRET 解出的 32 字节（decodeKey32），
 * 没配好（null）时一律回 vault_locked、记 misconfigured:vault_token_secret——不让带令牌的请求整个 500（导出照样能不带令牌做）。
 * loadEpoch 按 user_id 读当前 pin_epoch（没有 vault 行回 null；vault、account 经 withVaultUser，vault-image 经 withAiUser，6.2 A2）；
 *   出错就让它抛（调用方回 try_later），不当成通过。签名不过时不读库。
 * 回 'ok' 时带当前 epoch 和 firstAt（vault 拿它们续期）。
 */
export function vaultTokenChecker(
  secret: Bytes | null, now: () => number, loadEpoch: (userId: string) => Promise<number | null>, log?: (code: string) => void,
): (userId: string, token: string | null | undefined) => Promise<VaultTokenCheck> {
  return async (userId, token) => {
    if (!secret) {
      log?.('misconfigured:vault_token_secret');
      return { verdict: 'vault_locked' };
    }
    const sig = await checkSig(secret, userId, token, now());
    if (!sig) return { verdict: 'vault_locked' };
    const cur = await loadEpoch(userId);
    if (cur === null) return { verdict: 'vault_locked' };
    if (cur !== sig.epoch) return { verdict: 'vault_relock' };
    return { verdict: 'ok', epoch: cur, firstAt: sig.firstAt };
  };
}
