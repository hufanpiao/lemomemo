// 离开这台设备的统一入口（账号退出链路收口 11-20）：一律交给 core/device-exit.ts 的 exitDevice
// • createLeaveAccount：设置页、文件上传按原因离开；已经在走别的退出流程（boot.switching）时什么也不做；例外 deletion_unsure：闸是“会话没了”那一路设的
//   （boot.sessionGone）时只记下原因，那一路最后的 goToAuth('removed') 见已有原因就不覆盖，登录页显示“没能确认注销”
// • exitForAccountDisabled：收到 account_disabled 先探测再退出，主 App 同步、设置页、告知页、文件上传全走这一个（原来四份）。
//   各调用方只给：探测闸（createDisabledGate，一个作用域一个）、怎么离开、账号其实正常（active）时做什么
// • 不变量：只用被拒那次请求所用会话（sid）的令牌去查；探测期间不删会话；探测完别的退出流程已接手（boot.switching）就不动；
//   探测不出（断网、超时、拿不到令牌）一律按 disabled 只退出、不清本机库（不丢没上传的改动）；active 不离开
import type { AuthLossPath } from './auth-loss.ts';
import type { BootResult } from './boot.ts';
import { defaultExitDeps, exitDevice, exitOnSessionLoss, exitStarted, type ExitDeps } from './device-exit.ts';
import { exitAfterProbe, probeForSid, type AccountProbe, type DisabledExitOptions, type ProbedExit } from '../platform/account-status.ts';
import { rlog } from '../platform/run-log-api.ts';
import { setExitNotice } from '../platform/session.ts';
import { postReset } from '../platform/tab-leader.ts';

/** 回登录页时的提示：冷静期、已停用、探测不出（旧版本记下的）、申请注销后确认不了办没办成（deletion-check.ts）、被移除 */
export type AccountLeaveNotice = 'pending_deletion' | 'disabled' | 'disabled_unsure' | 'deletion_unsure' | 'removed';

export interface AccountLeaveDeps extends ExitDeps {
  /** 只记下退出原因、不跳转（见文件头 deletion_unsure） */
  setNotice(notice: AccountLeaveNotice, sid: string | null): void;
  /** 信号从哪来（lemo.authloss 记录用）；默认 files */
  authPath?: AuthLossPath;
}

export const defaultAccountLeaveDeps: AccountLeaveDeps = {
  ...defaultExitDeps,
  broadcastReset: postReset,
  // 清完库再发一条不带原因的 reset：设置页、插图上传原来就发（别的标签页整份重读，读到空库）
  broadcastWiped: (userId) => postReset(userId),
  setNotice: (notice, sid) => setExitNotice(notice, undefined, { sid }),
};

/** revoked：注销申请成功，服务器已吊销全部会话 */
export type LeaveAccount = (notice: AccountLeaveNotice, sid: string | null, o?: { revoked?: boolean }) => Promise<void>;

export function createLeaveAccount(deps: AccountLeaveDeps = defaultAccountLeaveDeps): LeaveAccount {
  return (notice, sid, o) => {
    const boot = deps.getBoot();
    if (boot?.switching) {
      rlog(`exit skip: switching notice=${notice}`);
      if (notice === 'deletion_unsure' && boot.sessionGone) deps.setNotice(notice, sid);
      return Promise.resolve();
    }
    return exitDevice({ reason: notice, sid, path: deps.authPath ?? 'files', ...(o?.revoked ? { revoked: true } : {}) }, deps);
  };
}

/**
 * 设置页的请求发现本机已经没有会话（settings-api 的 signed_out）：和别的标签页删了会话同一条路（core/device-exit.ts 的 exitOnSessionLoss）——
 * 是本账号的登录过期记号就跟着过期（只关库），否则跟着清库、不提示原因（第三方审查前端-4）
 */
export function createFollowSignOut(deps: ExitDeps = defaultAccountLeaveDeps): () => void {
  return () => exitOnSessionLoss({ here: false }, deps);
}

// ───────── 收到 account_disabled：先探测再退出 ─────────

/** Q-15：新建回 42501 时探出的“账号不可用”给随后的退出沿用多久（毫秒） */
export const DISABLED_KEEP_MS = 60_000;

export interface DisabledGateDeps extends DisabledExitOptions {
  /** 测试用：整个换掉探测（sid → 探测结果） */
  resolve?: (sid: string | null) => Promise<AccountProbe>;
  now?: () => number;
}

export interface DisabledGate {
  /**
   * 探测一次（platform/account-status.ts 的 probeForSid，只用 sid 那个会话的令牌）。永远 resolve，抛错按 unknown。
   * 同一个 sid 正在探就合用那一次（first = false）。keep：结果是已停用或冷静期时记下，DISABLED_KEEP_MS 内同一个 sid 的下一次直接沿用、用一次就清
   * （Q-15：免得令牌刚好刷新、第二次探测断网时结果变了）
   */
  probe(sid: string | null, o?: { keep?: boolean }): Promise<{ r: AccountProbe; first: boolean }>;
  /** 正在探测 */
  busy(): boolean;
  /** 这个作用域已经因为探测结果离开过：之后再来的不再探测 */
  left: boolean;
}

/** 一个作用域（一套同步接线、一个设置页、告知页、文件上传）一个闸 */
export function createDisabledGate(d: DisabledGateDeps = {}): DisabledGate {
  const now = d.now ?? (() => Date.now());
  const flying = new Map<string | null, Promise<AccountProbe>>();
  let kept: { sid: string | null; at: number; r: AccountProbe } | null = null;
  const run = async (sid: string | null): Promise<AccountProbe> => {
    try {
      return await (d.resolve ? d.resolve(sid) : probeForSid(sid, d));
    } catch {
      return { kind: 'unknown' };
    }
  };
  return {
    left: false,
    busy: () => flying.size > 0,
    async probe(sid, o) {
      const k = kept;
      if (k && k.sid === sid) {
        kept = null;
        const dt = now() - k.at;
        if (dt >= 0 && dt < DISABLED_KEEP_MS) return { r: k.r, first: true };
      }
      const going = flying.get(sid);
      if (going) return { r: await going, first: false };
      const p = run(sid);
      flying.set(sid, p);
      try {
        const r = await p;
        if (o?.keep && (r.kind === 'disabled' || r.kind === 'pending_deletion')) kept = { sid, at: now(), r };
        return { r, first: true };
      } finally {
        flying.delete(sid);
      }
    },
  };
}

export interface DisabledExitDeps {
  gate: DisabledGate;
  getBoot(): BootResult | null;
  /** 按探测出的原因离开这台设备（removed 也交给它：exitDevice 先查 session_fate 才清库） */
  leave(reason: ProbedExit, sid: string | null): Promise<void> | void;
}

/**
 * exitForAccountDisabled 的前一半：探测、定退出原因，不离开（文件上传器拿到原因后自己调 leave）。
 * active = 账号正常（合用同一次探测的每个调用方都收到）；skipped = 不用再管（这个作用域离开过、合用了别人的探测而那边去离开了、
 * 这一页已在退出或换账号）；其余是该离开的原因，这个作用域随即记为已离开
 */
export async function disabledExitOf(sid: string | null, d: Pick<DisabledExitDeps, 'gate' | 'getBoot'>): Promise<ProbedExit | 'active' | 'skipped'> {
  const before = d.getBoot();
  if (d.gate.left || before?.switching || exitStarted(before)) return 'skipped';
  const { r, first } = await d.gate.probe(sid);
  const v = exitAfterProbe(r);
  if (v === 'active') return 'active';
  if (!first || d.gate.left || d.getBoot()?.switching) return 'skipped';
  d.gate.left = true;
  return v;
}

/**
 * 收到 account_disabled：先探测再退出（见文件头）。sid：被拒那次请求所用的会话。
 * left = 已离开；active = 账号正常、没离开（调用方决定接下来怎么办）；skipped = 什么也没做（见 disabledExitOf）
 */
export async function exitForAccountDisabled(sid: string | null, d: DisabledExitDeps): Promise<'left' | 'active' | 'skipped'> {
  const v = await disabledExitOf(sid, d);
  if (v === 'active' || v === 'skipped') return v;
  await d.leave(v, sid);
  return 'left';
}
