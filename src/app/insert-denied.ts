// 新建被 RLS 拒（403、42501）时探测是不是账号已停用（Q-15，R-382；由 sync-wiring 接，不单独接线）
// • 新建走 PostgREST upsert，只受 RLS with check 里 private.is_active() 拦，停用、注销冷静期都只回 42501，带不出 account_disabled；
//   42501 还有别的来源（user_id 不符、bucket 等），不能直接当停用。所以先用被拒那次请求所用会话的令牌调一次 account status：
//   disabled、pending_deletion → check 返回 true，send.ts 把这一项当 account_disabled 交给 outbox（发 disabled 事件，走 R-382 的退出）；
//   active、unknown（断网、超时、拿不到令牌）、signed_out → false，照旧 permanent 进失败区。
// • 限次：一轮发送里多条只探一次由 send.ts 管；这里另管跨轮——上次探测后 5 分钟内不再探（42501 在失败区给“重试”，
//   不能每点一次重试就打一次 status），直接按 false。
// • 探测走同步接线的那个闸（core/account-leave.ts 的 createDisabledGate，keep）：随后 disabled 事件的退出沿用这次的结果、不再探第二次
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
