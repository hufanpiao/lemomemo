// 刷新令牌失败的那条记录（R-382 架构 4.1a 第 1 点 ①）：只在内存。从 refresh-observer.ts 拆出来——会话层（首屏）只要读这条，
// 观察那一层（observeRefresh）跟着 supabase 客户端懒加载
export interface RefreshFailure {
  code: string;
  status: number;
  at: number;
  sid: string | null;
}

/** 原因码的白名单格式（刷新令牌回包的 error_code / code，4.1a 第 1 点）；auth-loss-log.ts 有一份同值的（不进首屏，不 import 本文件），测试断言一致 */
export const AUTH_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** SIGNED_OUT 只认这么久以内的那条（4.1a） */
export const REFRESH_FAILURE_WINDOW_MS = 120_000;

let lastRefreshFailure: RefreshFailure | null = null;
let readSid: () => string | null = () => null;

/** platform/session.ts 挂上：同步读本机会话的 session_id（避免 client.ts ↔ session.ts 循环引用） */
export function setRefreshSessionReader(fn: () => string | null): void {
  readSid = fn;
}

/** 本机当前会话的 session_id（发刷新请求前读）；读不了为 null */
export function refreshSidNow(): string | null {
  try {
    return readSid();
  } catch {
    return null;
  }
}

/** 观察那一层记一条（失败）或清掉（成功，null） */
export function noteRefresh(f: RefreshFailure | null): void {
  lastRefreshFailure = f;
}

/** SIGNED_OUT 时取：windowMs 以内的那条，没有为 null（调用方当 code 'none'） */
export function recentRefreshFailure(now: number = Date.now(), windowMs: number = REFRESH_FAILURE_WINDOW_MS): RefreshFailure | null {
  const f = lastRefreshFailure;
  return f && now - f.at <= windowMs && f.at - now <= 1000 ? { ...f } : null;
}

/** 测试用 */
export function resetRefreshObserverForTest(): void {
  lastRefreshFailure = null;
  readSid = () => null;
}
