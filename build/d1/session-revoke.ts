// D1 第 6 节之三：会话的两个唯一出口（架构约定 10.1；迁移 20261112090000）。
// ① 删 auth.sessions 只准在 private.kill_session 里做，它同一函数里必须调 private.revoke_session。
//   为什么要查：被删了会话的设备再联网时，客户端只能经 public.session_fate 查 revoked_sessions 才知道“被移除”（要清本机）还是“登录过期”（不清）。
//   哪个入口只删会话、不写吊销记录，那台设备就会被当成登录过期、本机数据留着——平时看不出来，只在丢手机时出事。管理员停用不删会话（架构 0.62）。
// ② 校验密码会话（not_password_session）只准在 SESSION_CHECK_FNS 里：经 JWT 调的 *_impl 一律改调 private.require_live_session，
//   手抄的开场白以后改口径时容易漏改一份。rebind_device_impl 是 service_role 调的，按参数里的两个会话另校验，不经 require_live_session。
// 局限：只认静态 SQL；execute 拼出来的动态 SQL 查不到。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、prosrc），单测 tests/build/d1-session-revoke.test.ts，反例 supabase/tests/d1-fixtures/44、47。
import type { FnSrcRow } from './remind-lease.ts';

const DELETE_RE = /\bdelete\s+from\s+auth\s*\.\s*sessions\b/i;
const REVOKE_RE = /\bprivate\s*\.\s*revoke_session\s*\(/i;
const PW_CHECK_RE = /\bnot_password_session\s*\(/i;
/** 删会话的唯一出口 */
export const KILL_FN = 'kill_session';
/** 准自己调 not_password_session 的函数：会话校验的出口、RLS 用的 is_active、按参数校验的 rebind */
export const SESSION_CHECK_FNS = ['require_live_session', 'is_active', 'rebind_device_impl'] as const;

/** kill_session 以外删了 auth.sessions 的函数、或 kill_session 没调 revoke_session，各报一条 */
export function sessionRevokeProblems(fns: readonly FnSrcRow[]): string[] {
  return fns.filter((r) => DELETE_RE.test(r.src)).flatMap((r) => {
    if (r.f !== KILL_FN) return [`private.${r.f} 直接删了 auth.sessions（一律改调 private.${KILL_FN}，它同时写吊销记录；R-382）`];
    return REVOKE_RE.test(r.src) ? [] : [`private.${KILL_FN} 删了 auth.sessions，却没调 private.revoke_session（被删会话的设备会被当成登录过期、不清本机；R-382）`];
  });
}

/** SESSION_CHECK_FNS 以外自己调了 not_password_session 的函数，各报一条 */
export function sessionCheckProblems(fns: readonly FnSrcRow[]): string[] {
  const ok: readonly string[] = SESSION_CHECK_FNS;
  return fns.filter((r) => !ok.includes(r.f) && PW_CHECK_RE.test(r.src))
    .map((r) => `private.${r.f} 自己校验密码会话（not_password_session），会话校验一律改调 private.require_live_session（架构约定 10.1）`);
}
