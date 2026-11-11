// 会话丢了怎么分类（架构 4.1a 第 1 点；R-382，0.59 安全审 M1）：所有“会话没了”的信号都先交到这里，任何地方不得自己判“被移除”去清库
// • classifyAuthLoss(signal) → 'expired' | 'check'：
//   - check（要查服务器再定）：session_not_found、refresh_token_not_found、session_revoked（自家函数、RPC、outbox）、
//     devices_zero_rows（写本机 devices 行影响 0 行）
//   - 其余一律 expired：refresh_token_already_used、session_expired、别的 4xx、unparsable（AuthUnknownError、转发层回了非 JSON）、
//     network、none（拿不到码）
// • resolveAuthLoss(signal) → 'expired' | 'removed'：check 的才调 session_fate；回 revoked 是 removed，unknown 和查不了都是 expired。
//   没有 gone（0.59 M1：不回答账号存不存在）
// • 同一个会话（本页）出现过一次 removed，之后这个会话的信号都按 removed（4.1a“只处理一次”）
// • 每次结局都记一条 lemo.authloss（platform/auth-loss-log.ts：只有原因码、状态、结局、时刻、版本，uid_h 加盐哈希；
//   不含令牌、session_id、user_id 明文、邮箱、URL、原文）
// 纯 TS：不准 import React 和任何功能（A1）
import { pushAuthLoss, type AuthLossFate, type AuthLossPath } from '../platform/auth-loss-log.ts';
import { querySessionFate, type SessionFate } from '../platform/supabase/session-fate.ts';

export type { AuthLossPath } from '../platform/auth-loss-log.ts';
export type AuthLossClass = 'expired' | 'check';
export type AuthLossOutcome = 'expired' | 'removed';

/** 要查服务器再定的码 */
export const CHECK_CODES: readonly string[] = ['session_not_found', 'refresh_token_not_found', 'session_revoked', 'devices_zero_rows'];

export interface AuthLossSignal {
  path: AuthLossPath;
  /** 原因码（不认识、没有都行，按 expired） */
  code: string | null | undefined;
  /** HTTP 状态；不知道为 0 */
  status?: number;
  /** 作废的那个会话和它的账号（查服务器用）；任一为 null 就查不了，按 expired */
  sessionId: string | null;
  userId: string | null;
}

export function classifyAuthLoss(signal: Pick<AuthLossSignal, 'code'>): AuthLossClass {
  return typeof signal.code === 'string' && CHECK_CODES.includes(signal.code) ? 'check' : 'expired';
}

export interface ResolveDeps {
  /** 查 session_fate 用的 fetch（auth-loss-lazy.ts 传 http.ts 的 appFetch）；没给就查不了，按 unchecked */
  fetch?: typeof fetch;
  /** 本机 install_id（auth-loss-lazy.ts 传 device-info.ts 的 readInstallId）；没给就不记 lemo.authloss */
  installId?: () => string | null;
  /** 默认 platform/supabase/session-fate.ts 的 querySessionFate（带上面的 fetch）；查不了回 null */
  fate?: (sessionId: string, userId: string) => Promise<SessionFate | null>;
  /** 记录（默认 pushAuthLoss）；测试换掉 */
  record?: (e: { userId: string; path: AuthLossPath; code: string | null | undefined; status: number; fate: AuthLossFate }) => unknown;
}

/** 本页已经判成 removed 的会话 */
const removedSessions = new Set<string>();

/** 定结局：expired 或 removed。永远 resolve（查服务器出错按查不了） */
export async function resolveAuthLoss(signal: AuthLossSignal, deps: ResolveDeps = {}): Promise<AuthLossOutcome> {
  const { sessionId: sid, userId: uid } = signal;
  let fate: AuthLossFate;
  if (sid !== null && removedSessions.has(sid)) fate = 'revoked';
  else if (classifyAuthLoss(signal) === 'expired') fate = 'expired';
  else if (sid === null || uid === null) fate = 'unchecked';
  else {
    let f: SessionFate | null;
    try {
      const fetchFn = deps.fetch;
      f = deps.fate ? await deps.fate(sid, uid) : fetchFn ? await querySessionFate(sid, uid, { fetch: fetchFn }) : null;
    } catch {
      f = null;
    }
    fate = f ?? 'unchecked';
  }
  const outcome: AuthLossOutcome = fate === 'revoked' ? 'removed' : 'expired';
  if (outcome === 'removed' && sid !== null) removedSessions.add(sid);
  if (uid !== null) {
    const status = typeof signal.status === 'number' ? signal.status : 0;
    try {
      const r = (deps.record ?? ((e) => pushAuthLoss({ ...e, installId: deps.installId?.() ?? null })))({ userId: uid, path: signal.path, code: signal.code, status, fate });
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // 记不下不挡退出
    }
  }
  return outcome;
}

/** 测试用 */
export function resetAuthLossForTest(): void {
  removedSessions.clear();
}
