// 推送认领的共用入口：启动时（app/main.tsx）和设置 › 提醒的点按走同一套参数——跨标签页锁 `lemo-push-claim:<userId>`、
// 先等本会话设备行登记好（ensureDevice）、设备行不在了补登记（invalidateDevice）。
// • main.tsx 有账号时 setPushClaimContext(...)（只收函数，不 import core），再 runPushClaim()；设置页不传参，用同一份上下文；
//   上下文为空回 claim_failed，不绕开锁和登记去裸认领
// • 结果一律写进 push-status。退出、换账号时 setPushClaimContext(null) 并清空 push-status（core/account.ts 的 sealForExit、main.tsx 的换账号闸等）
// • 认领途中换了账号：push-claim.ts 订阅前、每次认领前比一次 currentUserId，不是这个账号就回 claim_failed，
//   不拿新账号的令牌认领旧账号的订阅；上下文被作废、换掉也当作不是本人（claimDeps 的 isCurrent）
// • main.tsx 首屏画完才设上下文，render 之前先 expectPushClaimContext()：这期间点按的认领等上下文，最多 PUSH_CLAIM_WAIT_MS，
//   到点或被设成 null 回 claim_failed；等的时候不碰推送订阅
// • push-claim.ts 按需下载：下载失败按 claim_failed 记，下次启动、下次点按再试
import { withLock } from './device-info.ts';
import type { EnsurePushDeps, EnsurePushOutcome } from './push-claim.ts';
import { setPushOutcome } from './push-status.ts';

export interface PushClaimContext {
  readonly userId: string;
  readonly platform: string;
  readonly claim: EnsurePushDeps['claim'];
  readonly sessionId: () => string | null;
  /** 本机会话里现在的 user_id；和 userId 不同就不订阅、不认领 */
  readonly currentUserId: () => string | null;
  readonly ensureDevice?: () => Promise<string | null>;
  readonly invalidateDevice?: (id: string) => Promise<void>;
}

let ctx: PushClaimContext | null = null;
/** expectPushClaimContext() 以后、setPushClaimContext(...) 之前为 true */
let expecting = false;
const waiters = new Set<(c: PushClaimContext | null) => void>();

/** 等上下文最多这么久（毫秒），到点回 claim_failed */
export const PUSH_CLAIM_WAIT_MS = 10_000;

/** 启动时设一次（有账号时）；退出、换账号时设 null，同时清掉上一账号的认领结果。等着上下文的认领随即用它（null 就回 claim_failed） */
export function setPushClaimContext(c: PushClaimContext | null): void {
  // 退出或换了账号：上一个账号的认领结果不能留给新账号看；先比较再赋值
  if (c === null || c.userId !== ctx?.userId) setPushOutcome(null);
  ctx = c;
  expecting = false;
  for (const w of [...waiters]) w(c);
}

/** 入口在设上下文之前调（main.tsx，render 之前）：之后的 runPushClaim() 先等上下文，不当场回 claim_failed。已经设过的不再等 */
export function expectPushClaimContext(): void {
  if (ctx === null) expecting = true;
}

function contextSoon(waitMs: number): Promise<PushClaimContext | null> {
  if (ctx !== null || !expecting) return Promise.resolve(ctx);
  return new Promise((done) => {
    const finish = (c: PushClaimContext | null): void => {
      clearTimeout(timer);
      waiters.delete(finish);
      done(c);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    waiters.add(finish);
  });
}

/** 测试用 */
export function resetPushClaimForTest(): void {
  ctx = null;
  expecting = false;
  for (const w of [...waiters]) w(null);
}

export type NamedLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * 两处共用的认领参数：带账号锁、设备登记。
 * isCurrent：这份上下文还是不是 setPushClaimContext 设的那一份；作废后 currentUserId 当作 null，
 * 进行中的认领在 push-claim.ts 下一个核对点就停，不靠别处的顺序挡住
 */
export function claimDeps(c: PushClaimContext, lock: NamedLock = (name, fn) => withLock(name, fn), isCurrent: () => boolean = () => true): EnsurePushDeps {
  return {
    userId: c.userId,
    platform: c.platform,
    claim: c.claim,
    sessionId: c.sessionId,
    currentUserId: () => (isCurrent() ? c.currentUserId() : null),
    ...(c.ensureDevice ? { ensureDevice: c.ensureDevice } : {}),
    ...(c.invalidateDevice ? { invalidateDevice: c.invalidateDevice } : {}),
    lock: (fn) => lock(`lemo-push-claim:${c.userId}`, fn),
  };
}

/** 默认的认领本体：按需下载 push-claim.ts；下载失败回 claim_failed（不抛，调用方照常写 push-status） */
const ensureLazy = (d: EnsurePushDeps): Promise<EnsurePushOutcome> =>
  import('./push-claim.ts').then(
    (m) => m.ensurePushSubscription(d),
    (): EnsurePushOutcome => ({ result: 'claim_failed' }),
  );

/**
 * 认领一次并把结果写进 push-status；上下文为空回 claim_failed。不传 c：用 setPushClaimContext 设的那一份，
 * 入口说过“马上会设”（expectPushClaimContext）时先等它，最多 waitMs
 */
export async function runPushClaim(
  c?: PushClaimContext | null,
  ensure: (d: EnsurePushDeps) => Promise<EnsurePushOutcome> = ensureLazy,
  waitMs: number = PUSH_CLAIM_WAIT_MS,
): Promise<EnsurePushOutcome> {
  const use = c === undefined ? await contextSoon(waitMs) : c;
  // 用的是全局那一份：认领途中它被换掉、作废，下一个核对点就停；显式传进来的照它自己
  const live = c === undefined ? () => ctx === use : undefined;
  const o: EnsurePushOutcome = use ? await ensure(claimDeps(use, undefined, live)) : { result: 'claim_failed' };
  setPushOutcome(o);
  return o;
}
