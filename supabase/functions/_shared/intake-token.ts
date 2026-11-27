// 连接码（架构 5.7、R-65；S-B3 中 6；B3 任务单 BE-5）：token-admin 生成、claude-intake 校验，两边共用这一份。
// • 码：前缀 lmc_ + 32 字节随机数的 base64url（256 bit），只在 token-admin 的响应里出现这一次；
// • 库里只存 SHA-256 的十六进制（api_tokens.token_hash，unique）：码本身熵够高，不需要另加密钥做 HMAC；
// • 180 天过期按 api_tokens.created_at 算（表里没有 expires_at 列，不改表）；吊销（revoked_at 不为空）立即失效；
// • 格式不对的码不查库（claude-intake 先按 TOKEN_RE 判，省一次查询，也挡住超长的 Authorization）。
// 纯函数：只用 Web Crypto，Deno 和 Vitest 都能跑；不 import npm 包、不碰 Deno 全局。

import { b64uEncode } from './b64url.ts';

export const TOKEN_PREFIX = 'lmc_';
export const TOKEN_RE = /^lmc_[A-Za-z0-9_-]{43}$/;
export const TOKEN_TTL_MS = 180 * 86_400_000;

export function randomToken(): string {
  return TOKEN_PREFIX + b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** created_at（ISO）起 180 天内、没吊销才算有效 */
export function tokenLive(row: { created_at: string; revoked_at: string | null }, now: number): boolean {
  if (row.revoked_at !== null) return false;
  const c = Date.parse(row.created_at);
  return Number.isFinite(c) && now < c + TOKEN_TTL_MS;
}
