// 主 App 收到 account_disabled 以后怎么办、别的标签页发来的退出原因怎么记（10-30 从 app/sync-wiring.ts 拆出来，让它回到 300 行以内；
// 由 sync-wiring 调，不单独接线）
// • 先探测（R-256 ③ 后续）：apply_patch 等 RLS 一路按 is_active() 判断，停用和注销冷静期都回 account_disabled，分不出来。
//   用被拒那次请求所用会话的令牌调 account {action:'status'}，经 platform/account-status.ts 的 exitForDisabled
//   （同意页、设置页、files 共用）定：pending_deletion → 冷静期退出；disabled → 停用退出；signed_out（错误码 unauthorized、session_revoked）
//   → 被移除；unknown（断网、超时、令牌拿不到、不带码的 401）→ 保守照停用清本机，提示 disabled_unsure；
//   active（刚好恢复了）→ 不清本机，重新载入页面重新同步（outbox 已设闸、闸只能靠重新载入解开；队列项还在库里，载入后照发）。
//   探测期间（最多 8 秒）不先删会话——探测要用它；之后照旧只按被拒那次的 sid 删。
//   sid 必填（K6-sugg5 ②）：fail 的调用方没给时 outbox 按 null 发——不拿本机现在那个会话的令牌探测，按 unknown（disabled_unsure）退出、只用 null 删
// • active 的重新载入有次数限制（10-30 复审必改）：RPC 一路 uid 为 null 时也回 account_disabled，探测用的却是本机存的令牌，
//   两边可能一直说不到一块，会无限重新载入。重新载入前在 sessionStorage 记下时刻（ACTIVE_RELOAD_KEY）；5 分钟内第二次遇到 active
//   就不再载入：闸保持关着，记日志 disabled_probe_active_loop，让出同步主页（免得别的标签页也都不同步），经 onSyncPaused 在顶部提示
//   “同步暂停，请稍后重新打开”；不清本机、不跳转。sessionStorage 读或写不了时也不载入（记不住就会循环）
// • 别的标签页发来的 reset 带退出原因（DISABLED-probe-later ②）：记下同一条（带上 sid），回登录页时显示。
//   本页会话已换成别的就不记：消息带 sid 时要和本页的对得上；不带 sid 时只在本页也没有会话时才记（第六轮审查建议 ①，免得 B 的标签页记下 A 的原因）
import type { BootResult } from '../core/boot.ts';
import type { SyncLog } from '../core/sync/types.ts';
import { exitForDisabled, type AccountProbe } from '../platform/account-status.ts';
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
  const r = await exitForDisabled(sid, { readSession: () => now, ...(probe ? { probe } : {}) });
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
