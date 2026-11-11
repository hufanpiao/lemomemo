// D1 第 6 节之三：删 auth.sessions 的 private 函数，同一函数里必须调 private.revoke_session（R-382，架构 4.1a 第 4 点吊销路径表；迁移 20261111120000）。
// 为什么要查：被删了会话的设备再联网时，客户端只能经 public.session_fate 查 revoked_sessions 才知道“被移除”（要清本机）还是“登录过期”（不清）。
//   哪个入口只删会话、不写吊销记录，那台设备就会被当成登录过期、本机数据留着——平时看不出来，只在丢手机时出事。
// 局限：只认静态 SQL 里的“delete from auth.sessions”和“private.revoke_session(”，不管两者是不是作用在同一批会话上；execute 拼出来的动态 SQL 查不到。
//   管理员停用不删会话（架构 0.62：只退出、不清本机），所以不在这里。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、prosrc，复用 remind-lease.ts 的 LEASE_FNS_SQL），单测 tests/build/d1-session-revoke.test.ts，
// 反例 supabase/tests/d1-fixtures/44_session_delete_no_revoke.psql。
import type { FnSrcRow } from './remind-lease.ts';

const DELETE_RE = /\bdelete\s+from\s+auth\s*\.\s*sessions\b/i;
const REVOKE_RE = /\bprivate\s*\.\s*revoke_session\s*\(/i;

/** 源码里删了 auth.sessions、却没调 private.revoke_session 的函数，各报一条 */
export function sessionRevokeProblems(fns: readonly FnSrcRow[]): string[] {
  return fns
    .filter((r) => DELETE_RE.test(r.src) && !REVOKE_RE.test(r.src))
    .map((r) => `private.${r.f} 删了 auth.sessions，却没调 private.revoke_session（被删会话的设备会被当成登录过期、不清本机；R-382，迁移 20261111120000）`);
}
