// 申请注销回 try_later 后先查真实状态（架构 0.47 第 22 条 T4；安全审查 H1 改过）：
// 服务器的 store 调用超时一律回 try_later，但超时的那次写入可能已经落库，也就是注销其实已经办成。
// 这时如果照旧提示“稍后再试”，用户再点一次会被冷静期拦住，或者白白多扣一次当天次数。
// 所以先用发请求那个会话的令牌调一次 account {action:'status'}（platform/account-status.ts 的 probeAccountForExit），再决定：
// • pending_deletion → 已办成，按冷静期离开（auth.exit.pendingDeletion）
// • signed_out（session_revoked、unauthorized）→ 确认不了（unsure）：申请注销在同一个事务里吊销全部会话
//   （supabase/functions/account/core.ts del ④），服务器又是先放行冷静期、再查会话，所以办成以后旧令牌查到的就是 session_revoked；
//   但别的设备刚好移除了本机也是这个结果，两者分不清。会话照删、清本机，登录页提示 auth.exit.deletionUnsure（“没能确认注销是否已经办好”），
//   不说冷静期（安全审查 H1）
// • 本机会话已经没了（getSession 刷新令牌被拒，auth-js 删了会话并发出 SIGNED_OUT）→ 同上 unsure。
//   这时本页的 SIGNED_OUT 一路（core/account.ts 的 watchAccount）已经先设了闸、在清本机，leave 不会清第二遍，
//   只记下 deletion_unsure，那一路最后的 goToAuth('removed') 不覆盖已有原因（见 account-exit.ts）
// • active → 没办成，照旧提示稍后再试
// • disabled → 交给已有的“账号停用”流程
// • unknown（断网、超时、本机会话已换人、刷新因断网失败而会话还在）→ 判断不了，照旧提示稍后再试（不猜）
import { probeAccountForExit, type AccountProbe } from '../../../platform/account-status.ts';
import { readSessionId, sessionIdOfToken } from '../../../platform/session.ts';
import { withTimeout } from '../../../platform/sign-out.ts';
import type { Db } from '../../../platform/supabase/client.ts';

export type DeletionCheck =
  | { kind: 'done'; purgeAfter: string | null }
  | { kind: 'unsure' }
  | { kind: 'not_done' }
  | { kind: 'disabled' }
  | { kind: 'unknown' };

/** status 的探测结果 → 注销办成了没有 */
export function deletionAfterProbe(p: AccountProbe): DeletionCheck {
  switch (p.kind) {
    case 'pending_deletion':
      return { kind: 'done', purgeAfter: p.purgeAfter };
    case 'signed_out':
      return { kind: 'unsure' };
    case 'active':
      return { kind: 'not_done' };
    case 'disabled':
      return { kind: 'disabled' };
    default:
      return { kind: 'unknown' };
  }
}

export interface CheckDeletionOptions {
  /** 测试用：换掉 status 探测（默认 probeAccountForExit，带这次会话的令牌） */
  probe?: (token: string) => Promise<AccountProbe>;
  /** 测试用：本机存着的会话的 session_id（默认 platform/session.ts 的 readSessionId） */
  localSid?: () => string | null;
  /** getSession（可能要刷新令牌）最多等多久，到点按 unknown（代码审查建议 2）；status 探测自己另有 8 秒上限 */
  sessionTimeoutMs?: number;
}

/** getSession 的上限 */
export const DELETION_SESSION_TIMEOUT_MS = 5000;

/**
 * sid：发注销请求时用的会话。本机会话现在还是它（令牌可能已刷新，session_id 不变）才去查；已换成别人的会话时 unknown——
 * 不能拿别人的会话去查（别的标签页换了账号）。永远 resolve
 */
export async function checkDeletion(getDb: () => Promise<Db>, sid: string | null, o: CheckDeletionOptions = {}): Promise<DeletionCheck> {
  if (sid === null) return { kind: 'unknown' };
  const probe = o.probe ?? ((token: string) => probeAccountForExit({ token, getDb }));
  try {
    const got = await withTimeout(
      async () => ({ token: (await (await getDb()).auth.getSession()).data.session?.access_token ?? null, late: false }),
      o.sessionTimeoutMs ?? DELETION_SESSION_TIMEOUT_MS,
      () => ({ token: null, late: true }),
    );
    if (got.late) return { kind: 'unknown' };
    const token = got.token;
    if (!token) return (o.localSid ?? readSessionId)() === null ? { kind: 'unsure' } : { kind: 'unknown' };
    if (sessionIdOfToken(token) !== sid) return { kind: 'unknown' };
    return deletionAfterProbe(await probe(token));
  } catch {
    return { kind: 'unknown' };
  }
}
