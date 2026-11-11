// 新建被 RLS 拒（403、42501）时探测是不是账号已停用（Q-15，R-382；由 sync-wiring 接，不单独接线）
// • 新建走 PostgREST upsert，只受 RLS with check 里 private.is_active() 拦，停用、注销冷静期都只回 42501，带不出 account_disabled；
//   42501 还有别的来源（user_id 不符、bucket 等），不能直接当停用。所以先用被拒那次请求所用会话的令牌调一次 account status：
//   disabled、pending_deletion → check 返回 true，send.ts 把这一项当 account_disabled 交给 outbox（发 disabled 事件，走 R-382 的退出）；
//   active、unknown（断网、超时、拿不到令牌）、signed_out → false，照旧 permanent 进失败区。
// • 限次：一轮发送里多条只探一次由 send.ts 管；这里另管跨轮——上次探测后 5 分钟内不再探（42501 在失败区给“重试”，
//   不能每点一次重试就打一次 status），直接按 false。
// • 探测出账号不可用后，sync-wiring 收到 disabled 事件走 probeThenLeave：经 take(sid) 沿用这次的结果（disabled 或 pending_deletion，
//   60 秒内、sid 相同、用一次就清），不再探第二次——令牌恰好刷新了、第二次探测断网回 unknown 时，也不会落成 disabled_unsure 去清本机（R-382）
import type { AccountProbe } from '../platform/account-status.ts';

/** 上次探测后多久内不再探（毫秒） */
export const INSERT_DENIED_WINDOW_MS = 5 * 60_000;
/** 探测出账号不可用的结果给随后的 probeThenLeave 沿用多久（毫秒） */
export const INSERT_DENIED_SHARE_MS = 60_000;

export interface InsertDeniedDeps {
  /** platform/account-status.ts 的 probeAccountForExit（带令牌） */
  probe(token: string): Promise<AccountProbe>;
  /** 本机会话现在的 session_id 和 access token */
  readSession(): { sid: string | null; token: string | null };
  now?: () => number;
}

export interface InsertDeniedCheck {
  /** 新建回 42501 后调：账号已停用或在冷静期为 true；sid = 被拒那次请求的会话。永远 resolve */
  check(sid: string | null): Promise<boolean>;
  /** 给 probeThenLeave 用：刚由 check 探出账号不可用、sid 相同时交出那次结果（用一次就清），否则 null（照常探测） */
  take(sid: string | null): AccountProbe | null;
}

const unusable = (r: AccountProbe): boolean => r.kind === 'disabled' || r.kind === 'pending_deletion';

export function createInsertDeniedCheck(d: InsertDeniedDeps): InsertDeniedCheck {
  const now = d.now ?? (() => Date.now());
  let lastAt: number | null = null;
  let shared: { sid: string; at: number; r: AccountProbe } | null = null;
  const fresh = (at: number, ms: number): boolean => {
    const dt = now() - at;
    return dt >= 0 && dt < ms;
  };
  return {
    async check(sid) {
      if (lastAt !== null && fresh(lastAt, INSERT_DENIED_WINDOW_MS)) return false;
      lastAt = now();
      let token: string | null = null;
      try {
        const s = d.readSession();
        // 本机会话已不是被拒那一个（别的标签页换了人）：不拿别人的令牌去查
        token = sid !== null && s.sid === sid ? s.token : null;
      } catch {
        token = null;
      }
      if (!token || sid === null) return false;
      let r: AccountProbe = { kind: 'unknown' };
      try {
        r = await d.probe(token);
      } catch {
        r = { kind: 'unknown' };
      }
      if (!unusable(r)) return false;
      shared = { sid, at: now(), r };
      return true;
    },
    take(sid) {
      // 只按被拒那次请求的 sid 取，不再核本机当前会话（独立验证 11-11 建议）：结论属于这个 sid 的账号；换账号（boot.switching）后对不上 sid 就取不到
      const s = shared;
      shared = null;
      return s && s.sid === sid && fresh(s.at, INSERT_DENIED_SHARE_MS) ? s.r : null;
    },
  };
}
