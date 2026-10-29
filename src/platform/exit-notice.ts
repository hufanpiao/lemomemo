// 退出原因（K6 复审 A：被移除、被停用、注销冷静期清本机后回登录页，登录页据此提示）。10-30 从 platform/session.ts 搬来，
// session.ts 原样转出（原有 import 不用改）。纯 TS，不碰 supabase
// • 存在本标签页的 sessionStorage（goToAuth 是同一个标签页跳转，跳过去还在）；只存原因、写下的时刻、被拒那次的 session_id，
//   不存账号、邮箱等任何个人信息
// • 会过期（第六轮审查建议 ②）：别的标签页广播来的原因（app/sync-wiring.ts 收 reset）先记下，本页要等 watchAccount 清完库才回登录页，
//   万一这一页没走到登录页，留着的原因不能等到以后某次正常退出时才冒出来。读的时候超过 EXIT_NOTICE_TTL_MS 就当没有（顺手删掉）。
//   本页自己写的原因走同一套
// • 存下的 sid 留着排查用（PROBE-sugg2 ①）：readExitNotice 不读它，登录页也不拿它和当前会话比对——
//   能走到登录页时作废的会话多半已删、当前会话读出来常是 null，比不出东西；“这条原因是不是本页会话的”已经在写之前把过关
//   （app/sync-disabled.ts 收广播时按 sid 比；本页自己退出时就是被拒的那个），再加 10 分钟过期兜底。
//   要查“提示和哪次会话对不上”时，在开发者工具里看 sessionStorage 的 lemo.exit_notice 就能对上 session_id
// • 旧格式（只有原因字符串，10-30 以前写的）按过期处理、读到就删（PROBE-sugg2 ②）：没有时刻判断不了新旧，宁可少一句提示

/** removed：会话被吊销（session_revoked）；disabled：账号被管理员停用（account_disabled）；pending_deletion：注销冷静期（account_pending_deletion，R-192） */
export type ExitNotice = 'removed' | 'disabled' | 'pending_deletion' | 'disabled_unsure';
// disabled_unsure（R-256 ③ 后续，10-30 加）：主 App 收到含糊的 account_disabled、探测 status 又没有结果（断网、超时），
// 保守按停用清了本机；登录页用不确定的说法（“暂时不能使用”，申请过注销的登录后可以恢复），见 platform/account-status.ts 的 exitAfterProbe

const EXIT_NOTICE_KEY = 'lemo.exit_notice';
const EXIT_NOTICES: readonly ExitNotice[] = ['removed', 'disabled', 'pending_deletion', 'disabled_unsure'];
/** 写下以后多久还算数 */
export const EXIT_NOTICE_TTL_MS = 10 * 60_000;

/** 按服务器的错误码定退出原因（不认识的一律算 removed） */
export function exitNoticeOf(code: string): ExitNotice {
  if (code === 'account_disabled') return 'disabled';
  if (code === 'account_pending_deletion') return 'pending_deletion';
  return 'removed';
}

/** 是不是认识的退出原因（tab-leader 的 reset 广播带来的 notice 收的一方用它核对；DISABLED-probe-later ②） */
export function isExitNotice(v: unknown): v is ExitNotice {
  return EXIT_NOTICES.some((n) => n === v);
}

/** o.sid：被拒那次请求的会话（有就记）；o.now：测试用 */
export function setExitNotice(n: ExitNotice, storage?: Storage, o: { sid?: string | null; now?: number } = {}): void {
  const v: { n: ExitNotice; at: number; sid?: string } = { n, at: o.now ?? Date.now() };
  if (o.sid) v.sid = o.sid;
  try {
    (storage ?? sessionStorage).setItem(EXIT_NOTICE_KEY, JSON.stringify(v));
  } catch {
    // 拿不到 sessionStorage：登录页就不提示原因
  }
}

/** 存着的值 → 原因和时刻；认不出（含旧格式）为 null */
function parse(raw: string | null): { n: ExitNotice; at: number } | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { n?: unknown; at?: unknown } | null;
    if (!v || !isExitNotice(v.n) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    return { n: v.n, at: v.at };
  } catch {
    return null;
  }
}

/**
 * 登录页读（有效的不删；渲染里读，StrictMode 调两次也一样）。认不出（含旧格式）、写下超过 10 分钟（或时刻在将来超过 1 分钟）
 * 按没有处理，并顺手删掉
 */
export function readExitNotice(storage?: Storage, now: number = Date.now()): ExitNotice | null {
  try {
    const st = storage ?? sessionStorage;
    const raw = st.getItem(EXIT_NOTICE_KEY);
    if (raw === null) return null;
    const v = parse(raw);
    if (!v || now - v.at >= EXIT_NOTICE_TTL_MS || v.at - now > 60_000) {
      st.removeItem(EXIT_NOTICE_KEY);
      return null;
    }
    return v.n;
  } catch {
    return null;
  }
}

/** 登录页显示过以后删掉（effect 里调），刷新登录页不再提示 */
export function clearExitNotice(storage?: Storage): void {
  try {
    (storage ?? sessionStorage).removeItem(EXIT_NOTICE_KEY);
  } catch {
    // 同上
  }
}
