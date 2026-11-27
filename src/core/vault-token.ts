// 隐私记令牌的内存位
// • 只在内存：不写 localStorage、IndexedDB、日志；刷新页面、上锁、relock 即丢
// • 写的只有隐私记会话（features/vault/data/session.ts）；读的是导出（settings/data/account-api.ts 带 x-vault-token）
// • expiresAt 是**本机时钟**的到期时刻，由会话按本机发出请求的时刻算（不存服务器给的 expires_at：拿本机时钟比，
//   本机时钟偏了就会早丢或多带过期令牌）。差 5 秒内也当过期，免得请求半路过期
export const VAULT_TOKEN_HEADER = 'x-vault-token';
const SKEW_MS = 5_000;

let held: { token: string; expiresAt: number } | null = null;

export function setVaultToken(token: string | null, expiresAt = 0): void {
  held = token ? { token, expiresAt } : null;
}

export function vaultToken(now: number = Date.now()): string | null {
  if (!held || held.expiresAt - SKEW_MS <= now) return null;
  return held.token;
}
