// 推送认领的共用入口（B2 FA-4 代码审查中 2）：启动时（app/main.tsx）和设置 › 提醒的点按（“打开通知”“重新接上”“移除它”后再认领）
// 走同一套参数——跨标签页锁 withLock(`lemo-push-claim:<userId>`)、先等本会话设备行登记好（ensureDevice）、设备行不在了补登记（invalidateDevice）。
// • main.tsx 在有账号时调一次 setPushClaimContext(...)（设备登记来自 core/device-reg，这里只收函数，不 import core），再 runPushClaim()；
// • 设置页 runPushClaim() 不传参，用同一份上下文；没启动、没账号（上下文为空）时回 claim_failed，不绕开锁和登记去裸认领；
// • 结果一律写进 push-status（设置 › 提醒 的顶部提示读它）。退出、换账号时 setPushClaimContext(null) 并清空 push-status
import { withLock } from './device-info.ts';
import { ensurePushSubscription, type EnsurePushDeps, type EnsurePushOutcome } from './push-claim.ts';
import { setPushOutcome } from './push-status.ts';

export interface PushClaimContext {
  readonly userId: string;
  readonly platform: string;
  readonly claim: EnsurePushDeps['claim'];
  readonly sessionId: () => string | null;
  readonly ensureDevice?: () => Promise<string | null>;
  readonly invalidateDevice?: (id: string) => Promise<void>;
}

let ctx: PushClaimContext | null = null;

/** 启动时设一次（有账号时）；退出、换账号时设 null，同时清掉上一账号的认领结果 */
export function setPushClaimContext(c: PushClaimContext | null): void {
  // 设成 null（退出登录）或换了账号：上一个账号的认领结果不能留给新账号看（代码审查 L5）；先比较再赋值
  if (c === null || c.userId !== ctx?.userId) setPushOutcome(null);
  ctx = c;
}

export type NamedLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** 两处共用的认领参数：带账号锁、设备登记 */
export function claimDeps(c: PushClaimContext, lock: NamedLock = (name, fn) => withLock(name, fn)): EnsurePushDeps {
  return {
    userId: c.userId,
    platform: c.platform,
    claim: c.claim,
    sessionId: c.sessionId,
    ...(c.ensureDevice ? { ensureDevice: c.ensureDevice } : {}),
    ...(c.invalidateDevice ? { invalidateDevice: c.invalidateDevice } : {}),
    lock: (fn) => lock(`lemo-push-claim:${c.userId}`, fn),
  };
}

/** 认领一次并把结果写进 push-status；上下文为空回 claim_failed */
export async function runPushClaim(
  c: PushClaimContext | null = ctx,
  ensure: (d: EnsurePushDeps) => Promise<EnsurePushOutcome> = ensurePushSubscription,
): Promise<EnsurePushOutcome> {
  const o: EnsurePushOutcome = c ? await ensure(claimDeps(c)) : { result: 'claim_failed' };
  setPushOutcome(o);
  return o;
}
