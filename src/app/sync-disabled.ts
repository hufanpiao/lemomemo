// 主 App 收到 account_disabled 以后怎么办、别的标签页发来的退出原因怎么记（由 app/sync-wiring.ts 调，不单独接线）
// 不变量：先用被拒那次的 sid 探测（platform/account-status.ts 的 exitForDisabled），探测期间不删会话；结局交 core/device-exit.ts（signed_out 也先查 session_fate）
// 不变量：sid 为 null、本机也没有会话时不探测，按 expired 只退出；active 的重新载入 5 分钟内只一次，第二次让出主页、顶部提示同步暂停
// 不变量：reset 带的原因只在 sid 对得上（不带 sid 时本页也没有会话）才记
// 详细说明见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import type { BootResult } from '../core/boot.ts';
import type { SyncLog } from '../core/sync/types.ts';
import { exitAfterProbe, exitForDisabled, type AccountProbe } from '../platform/account-status.ts';
import { isExitNotice, type ExitNotice } from '../platform/session.ts';
import type { SyncMessage } from '../platform/tab-leader.ts';

/** sync-wiring 的 WireSyncDeps 里和这里有关的几项 */
export interface SyncDisabledDeps {
  /** platform/exit-notice.ts 的 setExitNotice：回登录页前记下退出原因；sid：被拒那次请求的会话（有就记） */
  setExitNotice(n: ExitNotice, sid?: string | null): void;
  /**
   * 收到 account_disabled 时先探测：token 是被拒那次请求所用会话的令牌（platform/account-status.ts 的 probeAccountForExit）。
   * 和 readSession、reload 三个都给了才探测；不给就照旧直接按停用退出
   */
  probeAccount?: (token: string) => Promise<AccountProbe>;
  /**
   * 这个 sid 刚探测过、已知账号不可用（Q-15：新建回 42501 时 app/insert-denied.ts 探的）：给出结果就沿用、不再探第二次，
   * 免得第二次回 unknown 落成 disabled_unsure 清本机（R-382）。sync-wiring 接，不给照常探测
   */
  knownProbe?: (sid: string | null) => AccountProbe | null;
  /** 本机会话的 user_id（platform/session.ts 的 readSessionUserId）：sid 为 null 时据此分“没有会话”（按 removed）和“读不出 sid”（照旧探测） */
  readUserId?: () => string | null;
  /** 本机会话现在的 session_id 和 access token（platform/session.ts 的 readSessionId、readSessionAccessToken；只放内存） */
  readSession?: () => { sid: string | null; token: string | null };
  /** 探测结果是 active：不清本机，重新载入页面重新同步（platform/sw-register.ts 的 reloadPage） */
  reload?: () => void;
  /** 记“因 active 重新载入”时刻用的存储（默认 sessionStorage）和时钟；测试用 */
  reloadMarks?: () => Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
  /** 限次触发（disabled_probe_active_loop）、已让出同步主页后：顶部出“同步暂停，请稍后重新打开”的横幅（main.tsx 接 kit/state/ui-store） */
  onSyncPaused?: () => void;
  log?: SyncLog;
}

/** sessionStorage 里“因为探测是 active 而重新载入”的时刻（毫秒） */
export const ACTIVE_RELOAD_KEY = 'lemo.disabled_probe_reload_at';
/** 这段时间内第二次 active 不再重新载入 */
export const ACTIVE_RELOAD_WINDOW_MS = 5 * 60_000;

/** 能不能因为 active 重新载入：5 分钟内没载入过、并且这次的时刻记得下；存储读写出错一律不能 */
export function mayReloadForActive(deps: SyncDisabledDeps): boolean {
  try {
    const store = deps.reloadMarks ? deps.reloadMarks() : sessionStorage;
    const now = deps.now ? deps.now() : Date.now();
    const last = Number(store.getItem(ACTIVE_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < ACTIVE_RELOAD_WINDOW_MS) return false;
    store.setItem(ACTIVE_RELOAD_KEY, String(now));
    return store.getItem(ACTIVE_RELOAD_KEY) === String(now);
  } catch {
    return false;
  }
}

/** 本机会话现在的 session_id（读不了为 null） */
export function currentSid(deps: SyncDisabledDeps): string | null {
  try {
    return deps.readSession?.().sid ?? null;
  } catch {
    return null;
  }
}

/** sid 为 null 时本机是不是确实没有会话（见文件头）：readUserId 没给或读出错都不算 */
export function noLocalSession(deps: SyncDisabledDeps, sid: string | null): boolean {
  if (sid !== null || !deps.readUserId) return false;
  try {
    return deps.readUserId() === null;
  } catch {
    return false;
  }
}

/** 三个都给了才探测 */
export const canProbe = (deps: SyncDisabledDeps): boolean => Boolean(deps.probeAccount && deps.readSession && deps.reload);

/**
 * 先探测再决定（见文件头）。sid：被拒那次请求发出前本机会话的 session_id；null = 发请求时没有读得出的会话。
 * leave：按退出原因清本机、回登录页（sync-wiring 的那一套）；yieldLeader：让出同步主页。探测期间别的退出流程接手了（boot.switching）就不再处理
 */
export async function probeThenLeave(
  boot: BootResult,
  deps: SyncDisabledDeps,
  sid: string | null,
  leave: (notice: ExitNotice, dead: string | null) => void,
  yieldLeader: () => void,
): Promise<void> {
  let now: { sid: string | null; token: string | null } = { sid: null, token: null };
  try {
    now = deps.readSession?.() ?? now;
  } catch {
    // 存储不可用：拿不到令牌，按 unknown
  }
  // 本机会话已不是被拒那一个（别的标签页换了人）：exitForDisabled 不拿别人的令牌去查
  const probe = deps.probeAccount;
  const known = deps.knownProbe?.(sid) ?? null;
  const r = known ? exitAfterProbe(known) : await exitForDisabled(sid, { readSession: () => now, ...(probe ? { probe } : {}) });
  if (boot.switching) return;
  if (r !== 'active') return leave(r, sid);
  // 闸保持关着；只有 5 分钟内头一次、并且记得下时刻才重新载入
  if (mayReloadForActive(deps)) return void deps.reload?.();
  deps.log?.('disabled_probe_active_loop');
  yieldLeader();
  deps.onSyncPaused?.();
}

/** 别的标签页发来的 reset 带退出原因：会话还对得上时记下（见文件头） */
export function noteExitFromOtherTab(m: SyncMessage, deps: SyncDisabledDeps): void {
  if (m.type !== 'reset' || !isExitNotice(m.notice)) return;
  const mine = currentSid(deps);
  const theirs = m.sid ?? null;
  if (theirs === null ? mine !== null : mine !== null && mine !== theirs) return;
  try {
    deps.setExitNotice(m.notice, theirs);
  } catch {
    // sessionStorage 不可用：只是少一句提示
  }
}
