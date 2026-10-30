// account {action:'status'} 的探测（R-256 ③；10-30 架构师：登录页、主 App 收到 account_disabled 时都靠它分清“冷静期”和“已停用”）
// 登录页（features/auth/data/account-gate.ts）和主 App（app/sync-wiring.ts）共用这一份，不各写各的。
// • 手写判断、不引 zod：登录页的严格 CSP 下 zod 4 的 allowsEval 探测报 eval 违规，首屏也不该为一处校验带进 zod；
//   只借 shared/schema/account.ts 的类型（import type，打包时擦掉），和 accountStatusResponse 的一致性由
//   features/auth/__tests__/account-gate.test.ts 用 zod 对照守着。httpError 读错误码同理：手写的对应 shared/schema/api.ts 的
//   apiError（error 是 1～64 个码位的字符串才算），一致性由 account-gate.test.ts 的 apiError 对照用例守着（REVIEW-1030-be-sugg ①）
// • 经 supabase-js 的 functions.invoke 调（X-App-Version 由客户端带上）。token 给了就用它（Authorization: Bearer），
//   主 App 用被拒那次请求的会话令牌，免得探测时本机会话已被别的标签页换成别人、查到别人的状态
// • status：冷静期放行、不写库、不计次数（服务器）。回包 200 {ok, status}；管理员停用回 200 status:'disabled'（不是 403），
//   而且停用的判断排在会话检查前面：停用 + 会话已吊销时回的也是 disabled，不区分两者（后端审查 10-30）
// • 判断不了的（try_later、断网、超时、session_revoked、unauthorized、认不出的回包）一律 unknown，由调用方按场合处理
import type { AccountStatusResponse } from '../../shared/schema/account.ts';
import { readSessionAccessToken, readSessionId, type ExitNotice } from './session.ts';
import { withTimeout } from './sign-out.ts';
import { getSupabase, type Db } from './supabase/client.ts';

export const ACCOUNT_FN = 'account';
/** status 最多等多久（到点按 unknown） */
export const STATUS_TIMEOUT_MS = 8000;

export type AccountStatus =
  | { kind: 'active' }
  /** purgeAfter：ISO 时刻；服务器给 null、缺失或格式不对时为 null（界面换不带日期的说法） */
  | { kind: 'pending_deletion'; purgeAfter: string | null }
  | { kind: 'disabled' }
  | { kind: 'unknown' };

/**
 * 主 App 用的探测结果：多一种 signed_out（status 回错误码 unauthorized、session_revoked：令牌失效或会话已被吊销，
 * 和断网分开，按“已被移除”退出；10-30 复审）。登录页仍用 AccountStatus，signed_out 在那边照旧当 unknown
 */
export type AccountProbe = AccountStatus | { kind: 'signed_out' };

const SIGNED_OUT_CODES = new Set(['unauthorized', 'session_revoked']);

const STATUS_KINDS: readonly AccountStatusResponse['status'][] = ['active', 'pending_deletion', 'disabled'];

export function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** ISO 时刻能不能解析；不能为 null */
export function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * status 的 200 回包 → AccountStatus（手写的 accountStatusResponse；对不上的一律 unknown）。
 * 例外（审查建议 2）：status 是 pending_deletion 但缺 purge_after 或格式不对，仍按冷静期处理、purgeAfter 为 null（宁可多问一句恢复）
 */
export function parseStatus(body: unknown): AccountStatus {
  const o = obj(body);
  if (!o || o['ok'] !== true) return { kind: 'unknown' };
  const s = o['status'];
  if (!STATUS_KINDS.some((k) => k === s)) return { kind: 'unknown' };
  if (s === 'pending_deletion') return { kind: 'pending_deletion', purgeAfter: isoOrNull(o['purge_after']) };
  return s === 'disabled' ? { kind: 'disabled' } : { kind: 'active' };
}

/** FunctionsHttpError 的 context 是原始 Response：读出 HTTP 状态和 {error, purge_after}；不是 HTTP 错误为 null */
export async function httpError(e: unknown): Promise<{ status: number; code: string; body: Record<string, unknown> | null } | null> {
  const ctx = obj(e)?.['context'];
  if (!(ctx instanceof Response)) return null;
  let body: Record<string, unknown> | null = null;
  try {
    body = obj(await ctx.clone().json());
  } catch {
    body = null;
  }
  // 同 apiError：error 是 1～64 个码位的字符串才当错误码（按码位数，和 zod 4 的 min、max 一致：emoji 算 1 个，不按 UTF-16 码元算 2 个），
  // 别的（缺、空串、不是字符串、超长、老写法 {code}）都是 ''
  const code = body?.['error'];
  const n = typeof code === 'string' ? [...code].length : 0;
  return { status: ctx.status, code: typeof code === 'string' && n >= 1 && n <= 64 ? code : '', body };
}

/** status 的错误 → AccountStatus：万一回的是 403 account_disabled / account_pending_deletion 也认，其余 unknown */
export async function statusError(e: unknown): Promise<AccountStatus> {
  const r = await probeError(e);
  return r.kind === 'signed_out' ? { kind: 'unknown' } : r;
}

/** 同 statusError，另把错误码 unauthorized、session_revoked 认成 signed_out（主 App 用；不带码的 401 仍是 unknown） */
async function probeError(e: unknown): Promise<AccountProbe> {
  const h = await httpError(e);
  if (h?.code === 'account_disabled') return { kind: 'disabled' };
  if (h?.code === 'account_pending_deletion') return { kind: 'pending_deletion', purgeAfter: isoOrNull(h.body?.['purge_after']) };
  // 只认错误码（复审建议 10-30）：不带码的 401（令牌过期等）判断不了，归 unknown（提示 disabled_unsure）
  if (h && SIGNED_OUT_CODES.has(h.code)) return { kind: 'signed_out' };
  return { kind: 'unknown' };
}

type ProbeOpts = { token?: string | null; timeoutMs?: number; getDb?: () => Promise<Db> };

/** 调一次 status；永远 resolve。token 给了就用它，不给用客户端当前的会话；getDb 默认 getSupabase（登录页用：signed_out 当 unknown） */
export async function probeAccountStatus(o: ProbeOpts = {}): Promise<AccountStatus> {
  const r = await probeAccountForExit(o);
  return r.kind === 'signed_out' ? { kind: 'unknown' } : r;
}

/** 主 App 收到 account_disabled 后的探测：同 probeAccountStatus，但分得出 signed_out */
export function probeAccountForExit(o: ProbeOpts = {}): Promise<AccountProbe> {
  const getDb = o.getDb ?? getSupabase;
  return withTimeout(
    async (): Promise<AccountProbe> => {
      try {
        const db = await getDb();
        const { data, error } = await db.functions.invoke<unknown>(ACCOUNT_FN, {
          body: { action: 'status' },
          ...(o.token ? { headers: { Authorization: `Bearer ${o.token}` } } : {}),
        });
        return error ? await probeError(error) : parseStatus(data);
      } catch {
        return { kind: 'unknown' };
      }
    },
    o.timeoutMs ?? STATUS_TIMEOUT_MS,
    () => ({ kind: 'unknown' }),
  );
}

/**
 * 主 App 收到含糊的 account_disabled（RLS 一路的 is_active() 对停用、冷静期都回它）后探测的结果 → 怎么办（R-256 ③ 后续）：
 * - pending_deletion → 按冷静期退出（登录页 auth.exit.pendingDeletion，登录后能恢复）
 * - disabled → 按停用退出（auth.exit.disabled）
 * - unknown（断网、超时）→ 保守按停用流程清本机（服务器已经明确说了不让用），但登录页的提示用不确定的说法 disabled_unsure
 * - signed_out（错误码 unauthorized、session_revoked；不带码的 401 算 unknown）→ 按被移除退出（auth.exit.removed）
 * - active（刚好恢复了）→ 'active'：不清本机，重新同步（sync-wiring 限 5 分钟一次）
 */
/** 探测能给出的退出原因：不含 expired（那是本机没会话时 sync-wiring 自己定的，R-263） */
export type ProbedExit = Exclude<ExitNotice, 'expired'>;

export function exitAfterProbe(s: AccountProbe): ProbedExit | 'active' {
  switch (s.kind) {
    case 'signed_out':
      return 'removed';
    case 'pending_deletion':
      return 'pending_deletion';
    case 'disabled':
      return 'disabled';
    case 'active':
      return 'active';
    default:
      return 'disabled_unsure';
  }
}

export interface DisabledExitOptions {
  /** 本机会话现在的 session_id 和 access token（默认 platform/session.ts 的 readSessionId、readSessionAccessToken） */
  readSession?: () => { sid: string | null; token: string | null };
  /** 探测（默认 probeAccountForExit） */
  probe?: (token: string) => Promise<AccountProbe>;
  /**
   * 探测不出（unknown）时用哪个退出原因：默认 disabled_unsure（RLS 一路的 account_disabled 分不清停用和冷静期）；
   * 码本来就精确的地方（account 函数一路，经 requireActiveUser）传 'disabled'
   */
  fallback?: ProbedExit;
}

/**
 * 收到 account_disabled 后先探测再定退出原因（R-256 ③；sync-wiring、同意页、设置页、platform/files.ts 共用这一份，口径一致）：
 * - 只用被拒那次请求所用会话（sid）的令牌去查；本机会话已不是它（别的标签页换了人）或读不到令牌时不查，按 unknown
 * - 结果按 exitAfterProbe：pending_deletion / disabled / removed（signed_out）/ unknown → fallback / 'active'（刚好恢复了，不清本机）
 * 永远 resolve
 */
export async function exitForDisabled(sid: string | null, o: DisabledExitOptions = {}): Promise<ProbedExit | 'active'> {
  let now: { sid: string | null; token: string | null } = { sid: null, token: null };
  try {
    now = (o.readSession ?? (() => ({ sid: readSessionId(), token: readSessionAccessToken() })))();
  } catch {
    // 存储不可用：拿不到令牌，按 unknown
  }
  const token = sid !== null && now.sid === sid ? now.token : null;
  let status: AccountProbe = { kind: 'unknown' };
  if (token) {
    try {
      status = await (o.probe ?? ((t: string) => probeAccountForExit({ token: t })))(token);
    } catch {
      status = { kind: 'unknown' };
    }
  }
  const r = exitAfterProbe(status);
  return status.kind === 'unknown' && o.fallback ? o.fallback : r;
}
