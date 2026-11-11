// 登录过期的记号 lemo.reauth（架构 4.1a 第 2 点；R-382，0.60 复审建议 4、6）。原因码 lemo.authloss 和哈希在 auth-loss-log.ts（不进首屏）
// • lemo.reauth：expired、已停用时写 {v: 1, user_id, session_id, at, reason}，冷启动、别的标签页、登录页据此“只关库不清”。
//   reason（R-382 复核建议 ①）：'disabled' 已停用 / 'expired' 登录过期；登录页的提示以它为准（退出原因只存 sessionStorage，
//   刷新、iOS 杀掉重开就没了）。旧记号没有这个字段、或认不出的，一律按 expired（向后兼容）。
//   已停用优先：本账号已有 disabled 的记号时，再写 expired 不降级（照旧更新 session_id、at）；markReauthDisabled 把已有记号改成 disabled
//   不进日志、不进错误上报（本文件不带日志通道；单测钉住日志通道收不到它的 session_id）。
//   有效：v 为 1、user_id 是 uuid、session_id 是 uuid 或 null、at 在 30 天以内、且不比本机时间晚 1 天以上（防写个未来时间“永久保留”）
// • 存储不可用：写记号返回 false，调用方退回原来的做法（清库）并记 auth_loss_store_failed

export const REAUTH_KEY = 'lemo.reauth';
/** 原因码的键（内容和规则在 auth-loss-log.ts，那边有一份同值的，测试断言一致；删键放这里，退出、登录页“清除”不必带上哈希那一份） */
export const AUTH_LOSS_KEY = 'lemo.authloss';
/** 记号、原因码各自的有效期 */
export const REAUTH_TTL_MS = 30 * 24 * 3600_000;
/** 时间在未来超过这么多就当无效（0.60 复审建议 6） */
export const FUTURE_SKEW_MS = 24 * 3600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 记号记下的原因：已停用 / 登录过期 */
export type ReauthReason = 'disabled' | 'expired';

export interface Reauth {
  v: 1;
  user_id: string;
  session_id: string | null;
  at: number;
  reason: ReauthReason;
}

function store(s?: Storage): Storage {
  return s ?? localStorage;
}

/** at 还算数：不早于 ttl、不晚于现在 1 天以上 */
export function freshAt(at: unknown, now: number, ttl: number = REAUTH_TTL_MS): at is number {
  return typeof at === 'number' && Number.isFinite(at) && now - at < ttl && at - now <= FUTURE_SKEW_MS;
}

// ───────── lemo.reauth ─────────

/** 读记号；没有、认不出、过期、时间在未来 1 天以上都是 null（不删，删由调用方决定） */
export function readReauth(now: number = Date.now(), storage?: Storage): Reauth | null {
  try {
    const raw = store(storage).getItem(REAUTH_KEY);
    if (raw === null) return null;
    const o = JSON.parse(raw) as Partial<Record<keyof Reauth, unknown>> | null;
    if (!o || o.v !== 1 || typeof o.user_id !== 'string' || !UUID_RE.test(o.user_id)) return null;
    const sid = o.session_id;
    if (sid !== null && !(typeof sid === 'string' && UUID_RE.test(sid))) return null;
    if (!freshAt(o.at, now)) return null;
    return { v: 1, user_id: o.user_id, session_id: sid, at: o.at, reason: o.reason === 'disabled' ? 'disabled' : 'expired' };
  } catch {
    return null;
  }
}

/** 写记号；写不进、写了读不回都返回 false（调用方退回清库）。reason 不给按 expired；本账号已有 disabled 的记号时不降级（已停用优先） */
export function writeReauth(
  userId: string, sessionId: string | null, now: number = Date.now(), storage?: Storage, reason: ReauthReason = 'expired',
): boolean {
  if (!UUID_RE.test(userId) || (sessionId !== null && !UUID_RE.test(sessionId))) return false;
  try {
    const s = store(storage);
    const old = readReauth(now, s);
    const keep = reason === 'expired' && old?.user_id === userId && old.reason === 'disabled';
    const v = JSON.stringify({ v: 1, user_id: userId, session_id: sessionId, at: now, reason: keep ? 'disabled' : reason } satisfies Reauth);
    s.setItem(REAUTH_KEY, v);
    return s.getItem(REAUTH_KEY) === v;
  } catch {
    return false;
  }
}

/** 已停用优先（0.60 复审建议 2）：已有记号就把原因改成 disabled（session_id、at 不变）；没有记号什么也不做。返回改没改成 */
export function markReauthDisabled(now: number = Date.now(), storage?: Storage): boolean {
  const r = readReauth(now, storage);
  if (!r) return false;
  if (r.reason === 'disabled') return true;
  try {
    const s = store(storage);
    const v = JSON.stringify({ ...r, reason: 'disabled' } satisfies Reauth);
    s.setItem(REAUTH_KEY, v);
    return s.getItem(REAUTH_KEY) === v;
  } catch {
    return false;
  }
}

/** 本机有没有 lemo.authloss（main.tsx 据此决定要不要下载 auth-loss-log.ts）；读不了当没有 */
export function hasAuthLoss(storage?: Storage): boolean {
  try {
    return store(storage).getItem(AUTH_LOSS_KEY) !== null;
  } catch {
    return false;
  }
}

/** 删 lemo.authloss：本人主动清除（K9、登录页“清除”）才调；被动清库不调 */
export function clearAuthLoss(storage?: Storage): void {
  try {
    store(storage).removeItem(AUTH_LOSS_KEY);
  } catch {
    // 存储不可用：本来也存不下
  }
}

/** 删记号；删不掉返回 false（调用方记 auth_loss_store_failed） */
export function clearReauth(storage?: Storage): boolean {
  try {
    const s = store(storage);
    s.removeItem(REAUTH_KEY);
    return s.getItem(REAUTH_KEY) === null;
  } catch {
    return false;
  }
}
