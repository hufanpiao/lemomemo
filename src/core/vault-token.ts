// 隐私记令牌的内存位（B5 S10；架构 0.29 续第 93、94 条）
// • 只在内存：不写 localStorage、IndexedDB、日志；刷新页面、上锁、relock 即丢
// • 写的只有隐私记会话（features/vault/data/session.ts）；读的是导出（settings/data/account-api.ts 带 x-vault-token）
// • 过期的不给（服务器 TTL 600 秒；差 5 秒内也当过期，免得请求半路过期）
export const VAULT_TOKEN_HEADER = 'x-vault-token';
const SKEW_MS = 5_000;

let held: { token: string; expiresAt: number } | null = null;
const listeners = new Set<() => void>();

export function setVaultToken(token: string | null, expiresAt = 0): void {
  held = token ? { token, expiresAt } : null;
  for (const fn of [...listeners]) fn();
}

export function vaultToken(now: number = Date.now()): string | null {
  if (!held || held.expiresAt - SKEW_MS <= now) return null;
  return held.token;
}

/** 令牌换了、丢了时回调（导出页据此决定要不要提示先解锁）；返回取消函数 */
export function onVaultToken(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
