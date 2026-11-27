// account {action:'status'} 的探测：收到 account_disabled 时分清“冷静期”和“已停用”。登录页和主 App 共用这一份。
// • 手写判断、不引 zod：登录页严格 CSP 下 zod 4 的 allowsEval 探测报 eval 违规，首屏也不该带进 zod；
//   只借 shared/schema 的类型（import type），和 accountStatusResponse、apiError 的一致性由
//   features/auth/__tests__/account-gate.test.ts 用 zod 对照守着
// • 经 functions.invoke 调。token 给了就用它：主 App 用被拒那次请求的会话令牌，免得本机会话已被别的标签页换人、查到别人的状态
// • 服务器的 status 不写库、不计次数；停用回 200 status:'disabled'（不是 403），且停用判断排在会话检查前面，停用 + 会话吊销也回 disabled
// • 判断不了的（try_later、断网、超时、认不出的回包）一律 unknown，由调用方按场合处理
import type { AccountStatusResponse } from '../../shared/schema/account.ts';
import { readSessionAccessToken, readSessionId, type ExitNotice } from './session.ts';
import { withTimeout } from './exit-basics.ts';
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

/** 主 App 用的探测结果：多一种 signed_out（错误码 unauthorized、session_revoked，按“已被移除”退出）。登录页把它当 unknown */
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
 * status 的 200 回包 → AccountStatus（对不上的一律 unknown）。
 * 例外：pending_deletion 缺 purge_after 或格式不对，仍按冷静期、purgeAfter 为 null（宁可多问一句恢复）
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
  // 同 apiError：error 是 1～64 个码位的字符串才当错误码（按码位数，和 zod 4 一致），别的都是 ''
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
  // 只认错误码：不带码的 401（令牌过期等）判断不了，归 unknown
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
 * 收到含糊的 account_disabled（is_active() 对停用、冷静期都回它）后探测的结果 → 怎么办：
 * - pending_deletion → 按冷静期退出（登录后能恢复）
 * - disabled → 按停用退出：只退出、不清本机库
 * - unknown（断网、超时、拿不到令牌）→ 也按 disabled（不丢没上传的改动）
 * - signed_out → 按被移除退出（先查 session_fate 才清库）
 * - active（刚好恢复了）→ 'active'：不离开，由调用方决定
 */
/** 探测能给出的退出原因：不含 expired（那是本机没会话时 sync-wiring 自己定的） */
export type ProbedExit = Exclude<ExitNotice, 'expired'>;

export function exitAfterProbe(s: AccountProbe): ProbedExit | 'active' {
  switch (s.kind) {
    case 'signed_out':
      return 'removed';
    case 'pending_deletion':
      return 'pending_deletion';
    case 'active':
      return 'active';
    default:
      return 'disabled';
  }
}

export interface DisabledExitOptions {
  /** 本机会话现在的 session_id 和 access token（默认读 session.ts） */
  readSession?: () => { sid: string | null; token: string | null };
  /** 探测（默认 probeAccountForExit） */
  probe?: (token: string) => Promise<AccountProbe>;
}

/**
 * 探测 + 定退出原因。只剩文件上传一路（files.ts 的 accountExitOf）直接用、没有单飞；
 * 以后那一路改走 core/account-leave.ts 的闸后删掉这个
 */
export async function exitForDisabled(sid: string | null, o: DisabledExitOptions = {}): Promise<ProbedExit | 'active'> {
  return exitAfterProbe(await probeForSid(sid, o));
}

/**
 * 收到 account_disabled 后的探测（core/account-leave.ts 的 createDisabledGate 调它）：
 * 只用被拒那次请求所用会话（sid）的令牌去查；本机会话已不是它、sid 为 null、读不到令牌时不查，按 unknown。永远 resolve
 */
export async function probeForSid(sid: string | null, o: DisabledExitOptions = {}): Promise<AccountProbe> {
  let now: { sid: string | null; token: string | null } = { sid: null, token: null };
  try {
    now = (o.readSession ?? (() => ({ sid: readSessionId(), token: readSessionAccessToken() })))();
  } catch {
    // 存储不可用：拿不到令牌，按 unknown
  }
  const token = sid !== null && now.sid === sid ? now.token : null;
  if (!token) return { kind: 'unknown' };
  try {
    return await (o.probe ?? ((t: string) => probeAccountForExit({ token: t })))(token);
  } catch {
    return { kind: 'unknown' };
  }
}
