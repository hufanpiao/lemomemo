// 新建被 RLS 拒（403、42501）时探测是不是账号已停用（由 sync-wiring 接）
// • 新建只受 RLS 里 private.is_active() 拦，停用、冷静期都只回 42501；42501 还有别的来源，不能直接当停用。
//   所以先用被拒那次请求的令牌调一次 account status：disabled、pending_deletion → true（send.ts 当 account_disabled 交给 outbox）；
//   active、unknown、signed_out → false，照旧 permanent 进失败区。
// • 限次：一轮内只探一次由 send.ts 管；这里管跨轮：上次探测后 5 分钟内不再探（失败区的“重试”不能每点一次就打一次 status）
// • 探测走同步接线的那个闸（createDisabledGate，keep）：随后 disabled 事件的退出沿用这次的结果、不再探第二次
import type { DisabledGate } from '../core/account-leave.ts';

/** 上次探测后多久内不再探（毫秒） */
export const INSERT_DENIED_WINDOW_MS = 5 * 60_000;

/** 新建回 42501 后调：账号已停用或在冷静期为 true；sid = 被拒那次请求的会话。永远 resolve */
export type InsertDeniedCheck = (sid: string | null) => Promise<boolean>;

export function createInsertDeniedCheck(gate: DisabledGate, now: () => number = () => Date.now()): InsertDeniedCheck {
  let lastAt: number | null = null;
  return async (sid) => {
    if (lastAt !== null) {
      const dt = now() - lastAt;
      if (dt >= 0 && dt < INSERT_DENIED_WINDOW_MS) return false;
    }
    lastAt = now();
    const { r } = await gate.probe(sid, { keep: true });
    return r.kind === 'disabled' || r.kind === 'pending_deletion';
  };
}
