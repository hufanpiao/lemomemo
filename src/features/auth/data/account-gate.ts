// 登录页调 account 函数的小封装：只有 status、restore 两个动作，外加恢复页“保持注销并退出”要的 signOut local
// （R-256 ③、架构 0.29 续第 131 条④、第 6 节“account 的错误码”；10-30 架构师：登录页靠 status 判断要不要显示恢复页）
// • 放在 auth 自己的 data 层：设置页的 account-api.ts 引了 zod（accountErrorCode），登录页不带 zod（auth-api.ts 同理，
//   zod 4 的 allowsEval 探测在登录页的严格 CSP 下报 eval 违规），所以这里手写判断；只借 shared/schema/account.ts 的类型
//   （import type，打包时擦掉），和 accountStatusResponse 的一致性由 __tests__/account-gate.test.ts 用 zod 对照守着
// • 经 supabase-js 的 functions.invoke 调（会话令牌、X-App-Version 由客户端带上），和 invite-signup 一样
// • status：冷静期放行、不写库、不计次数（服务器）。回包 200 {ok, status}；管理员停用回 200 status:'disabled'（不是 403），
//   而且停用的判断排在会话检查前面：停用 + 会话已吊销时回的也是 disabled，这里不区分两者（后端审查 10-30）。
//   disabled 一律按“已停用”处理，绝不能因为 ok:true 就当成正常登录（后端审查 10-30）
// • 判断不了的（try_later、断网、超时、session_revoked、unauthorized、认不出的回包）一律 unknown。怎么处理由调用方按路分（R-258）：
//   验证码刚通过时不进 App，原地出“暂时无法确认账号状态”，给“重试”“仍然进入”；SessionCheck（本机已有会话）不挡，保证离线能用
import {
  ACCOUNT_FN,
  httpError,
  obj,
  parseStatus,
  probeAccountStatus,
  STATUS_TIMEOUT_MS,
  statusError,
  type AccountStatus,
} from '../../../platform/account-status.ts';
import { readSessionAccessToken, readSessionId } from '../../../platform/session.ts';
import { budgetLeft, logoutReplaced, sessionReplaced, withTimeout, type PriorSession } from '../../../platform/sign-out.ts';
import type { Db } from '../../../platform/supabase/client.ts';

// status 的判断（parseStatus、statusError）和调用（probeAccountStatus）在 platform/account-status.ts，主 App 收到 account_disabled 时也用它
export { ACCOUNT_FN, parseStatus, STATUS_TIMEOUT_MS, statusError, type AccountStatus };
/** restore 最多等多久（到点按 try_later，再查一次 status 确认是不是其实已经恢复，见 restore 的 T4 一段） */
export const RESTORE_TIMEOUT_MS = 20_000;

export type RestoreErr =
  /** 最近 10 分钟内没用邮箱验证码登录过（会话失效也归这里）：删本会话、回填邮箱那一步重新收码 */
  | 'reauth_required'
  /** account-purge 已开始删除 */
  | 'restore_too_late'
  /** 每天 5 次 */
  | 'rate_limited'
  /** 冷静期里又被管理员停用 */
  | 'account_disabled'
  /** 已经不在冷静期（别处恢复过、上次超时其实成功了）：照常进 App */
  | 'not_pending'
  | 'try_later'
  | 'offline'
  | 'unknown';

export type RestoreResult = { ok: true } | { ok: false; error: RestoreErr };

export interface AccountGateApi {
  status(): Promise<AccountStatus>;
  restore(): Promise<RestoreResult>;
  /**
   * signOut({scope: 'local'})：只吊销本会话；true = 服务器上已吊销（或本来就不在）。不删 devices 行。
   * prior（signOutThisDevice 传来的退出前会话）：拿到客户端以后、紧贴 signOut 之前本机会话已换成别的，就不调 supabase-js，
   * 改用旧令牌直接 /logout（platform/sign-out.ts 的 logoutReplaced，K6-signout-lib）
   */
  signOutLocal(prior?: PriorSession): Promise<boolean>;
}

function isOffline(e: unknown): boolean {
  const name = obj(e)?.['name'];
  return name === 'FunctionsFetchError' || name === 'TypeError';
}

const RESTORE_CODES: Readonly<Record<string, RestoreErr>> = {
  reauth_required: 'reauth_required',
  restore_too_late: 'restore_too_late',
  rate_limited: 'rate_limited',
  account_disabled: 'account_disabled',
  not_pending: 'not_pending',
  try_later: 'try_later',
  // 会话已吊销、没登录：这个会话恢复不了，和 reauth_required 一样删掉它重新收码
  session_revoked: 'reauth_required',
  unauthorized: 'reauth_required',
};

/** restore 的错误 → RestoreErr */
export async function restoreError(e: unknown): Promise<RestoreErr> {
  const h = await httpError(e);
  if (h) {
    if (Object.hasOwn(RESTORE_CODES, h.code)) return RESTORE_CODES[h.code] ?? 'unknown';
    // 401 且回包没有 error 字段（网关、令牌过期等）：这个会话用不了，同 reauth_required（审查建议 1）
    if (h.status === 401 && h.code === '') return 'reauth_required';
    if (h.status === 429) return 'rate_limited';
    if (h.status === 503) return 'try_later';
    return 'unknown';
  }
  return isOffline(e) ? 'offline' : 'unknown';
}

export interface AccountGateOptions {
  statusTimeoutMs?: number;
  restoreTimeoutMs?: number;
  /** 测试用：本机存着的会话（默认 platform/session.ts 的 readSessionId、readSessionAccessToken；只读存储，不刷新令牌） */
  readSession?: () => { sid: string | null; token: string | null };
}

function readLocalSession(): { sid: string | null; token: string | null } {
  try {
    return { sid: readSessionId(), token: readSessionAccessToken() };
  } catch {
    return { sid: null, token: null };
  }
}

export function createAccountGateApi(getDb: () => Promise<Db>, o: AccountGateOptions = {}): AccountGateApi {
  const call = async (action: 'restore') => (await getDb()).functions.invoke<unknown>(ACCOUNT_FN, { body: { action } });
  return {
    status: () => probeAccountStatus({ getDb, timeoutMs: o.statusTimeoutMs ?? STATUS_TIMEOUT_MS }),

    restore: async () => {
      // 发请求前记下这次用的会话（代码审查必改）：restore 最多等 20 秒，期间别的标签页可能换登了别人，查 status 只能用同一个会话
      const read = o.readSession ?? readLocalSession;
      const before = read().sid;
      const r = await withTimeout(
        async (): Promise<RestoreResult> => {
          try {
            const { error } = await call('restore');
            return error ? { ok: false, error: await restoreError(error) } : { ok: true };
          } catch (e) {
            return { ok: false, error: isOffline(e) ? 'offline' : 'unknown' };
          }
        },
        o.restoreTimeoutMs ?? RESTORE_TIMEOUT_MS,
        (): RestoreResult => ({ ok: false, error: 'try_later' }),
      );
      // 0.47 第 22 条 T4：try_later（含超时）可能其实已经恢复了，先查一次 status：active 按恢复成功；
      // 仍是冷静期、停用或查不出（unknown）照旧 try_later（停用留给下次登录时的 status 处理，这里不猜）
      // 本机会话已不是发请求的那一个（换了人、没了）或读不到令牌：不查，照旧 try_later；是同一个就用它现在的令牌（可能已刷新，session_id 不变）去查
      if (r.ok || r.error !== 'try_later' || before === null) return r;
      const now = read();
      if (now.sid !== before || !now.token) return r;
      const s = await probeAccountStatus({ getDb, token: now.token, timeoutMs: o.statusTimeoutMs ?? STATUS_TIMEOUT_MS });
      return s.kind === 'active' ? { ok: true } : r;
    },

    signOutLocal: async (prior) => {
      const t0 = Date.now();
      try {
        const db = await getDb();
        // 预算扣掉拿客户端用掉的时间（和 auth-api、settings-api 同一口径，K6-signout-lib 复审建议 ②）
        if (prior && sessionReplaced(prior.sid)) return (await logoutReplaced(prior.token, budgetLeft(prior.budgetMs, t0))).serverDone;
        const { error } = await db.auth.signOut({ scope: 'local' });
        return !error;
      } catch {
        return false;
      }
    },
  };
}

/** 彻底删除时刻在本机时区的各部分（填进词条 auth.restore.when） */
export interface PurgeWhen {
  y: string;
  m: string;
  d: string;
  hh: string;
  mm: string;
  zone: string;
}

/**
 * 彻底删除的时刻按本机时区拆成“日期 时刻”的各部分，口径同邮件的 fmtWhen（supabase/functions/_shared/account-mail.ts）：
 * 词条 auth.restore.when 拼成 zh 2026年11月5日 14:30（Asia/Seoul）、ko 2026년 11월 5일 14:30 (Asia/Seoul)（文字只放词典，A20）。
 * 不用 toLocaleString（各 ICU 标点不同）。iso 为 null 或解析不了为 null（界面换不带日期的说法）；
 * tz 默认本机时区，取不到或不能用按首尔（同 fmtWhen 的 safeTz）
 */
export function purgeWhen(iso: string | null, tz?: string): PurgeWhen | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const zone = safeZone(tz ?? localZone());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour').padStart(2, '0'), mm: get('minute').padStart(2, '0'), zone };
}

const FALLBACK_TZ = 'Asia/Seoul';

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return FALLBACK_TZ;
  }
}

function safeZone(tz: string): string {
  if (!tz || tz.length > 64) return FALLBACK_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}
