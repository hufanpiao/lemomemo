// 推送认领的共用入口（B2 FA-4 代码审查中 2）：启动认领（main.tsx）和设置 › 提醒 的点按认领（reminders 的 claimNow）走同一份参数——
// 账号锁 lemo-push-claim:<userId>、ensureDevice、invalidateDevice；上下文为空时不裸认领
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ensure = vi.fn(async (..._a: unknown[]) => ({ result: 'claimed' as const }));
vi.mock('../push-claim.ts', () => ({ ensurePushSubscription: (...a: unknown[]) => ensure(...a) }));

const { claimDeps, expectPushClaimContext, PUSH_CLAIM_WAIT_MS, resetPushClaimForTest, runPushClaim, setPushClaimContext } = await import('../push-claim-run.ts');
const { getPushOutcome, setPushOutcome } = await import('../push-status.ts');

const ensureDevice = vi.fn(async () => 'dev-1');
const invalidateDevice = vi.fn(async () => undefined);
const ctx = { userId: 'u1', platform: 'web', claim: vi.fn(), sessionId: () => 's1', ensureDevice, invalidateDevice };

afterEach(() => {
  vi.useRealTimers();
  resetPushClaimForTest();
  setPushClaimContext(null);
  ensure.mockClear();
});

describe('推送认领的共用参数', () => {
  it('带账号锁和设备登记', async () => {
    const names: string[] = [];
    const lock = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      names.push(name);
      return fn();
    };
    const d = claimDeps(ctx, lock);
    expect(d.ensureDevice).toBe(ensureDevice);
    expect(d.invalidateDevice).toBe(invalidateDevice);
    expect(d.userId).toBe('u1');
    await d.lock?.(async () => 1);
    expect(names).toEqual(['lemo-push-claim:u1']);
  });
  it('runPushClaim 用 setPushClaimContext 设的那一份（启动和设置页都不传参），结果写进 push-status', async () => {
    setPushClaimContext(ctx);
    const o = await runPushClaim();
    expect(o).toEqual({ result: 'claimed' });
    const deps = ensure.mock.calls[0]?.[0] as { ensureDevice?: unknown; invalidateDevice?: unknown; lock?: unknown; userId: string };
    expect(deps.ensureDevice).toBe(ensureDevice);
    expect(deps.invalidateDevice).toBe(invalidateDevice);
    expect(typeof deps.lock).toBe('function');
    expect(getPushOutcome()).toEqual({ result: 'claimed' });
  });
  it('没设上下文（没启动、没账号）：回 claim_failed，不去裸认领', async () => {
    expect(await runPushClaim()).toEqual({ result: 'claim_failed' });
    expect(ensure).not.toHaveBeenCalled();
  });
  it('清空上下文时连上一账号的认领结果一起清掉', () => {
    setPushOutcome({ result: 'claimed' });
    setPushClaimContext(null);
    expect(getPushOutcome()).toBeNull();
  });
  it('账号变化时重置 push-status：换账号清掉，设成 null 清掉，同一账号重设不清（代码审查 L5）', () => {
    setPushClaimContext(ctx);
    setPushOutcome({ result: 'claimed' });
    setPushClaimContext({ ...ctx, sessionId: () => 's2' });
    expect(getPushOutcome()).toEqual({ result: 'claimed' });
    setPushClaimContext({ ...ctx, userId: 'u2' });
    expect(getPushOutcome()).toBeNull();
    setPushOutcome({ result: 'claimed' });
    setPushClaimContext(null);
    expect(getPushOutcome()).toBeNull();
  });
  it('两处调用方：main.tsx 设上下文并调 runPushClaim、不再自己拼 ensurePushSubscription；设置页的 claimNow 只调 runPushClaim', () => {
    const main = readFileSync('src/app/main.tsx', 'utf8');
    expect(main).toContain('setPushClaimContext({');
    expect(main).toContain('runPushClaim()');
    expect(main).not.toContain('ensurePushSubscription(');
    const setup = readFileSync('src/features/reminders/data/push-setup.ts', 'utf8');
    expect(setup).toMatch(/export async function claimNow\(\): Promise<EnsurePushOutcome> \{\s*return runPushClaim\(\);\s*\}/);
    expect(setup).not.toContain('ensurePushSubscription');
  });
});

describe('等上下文（B2 FA-6 推迟启动审查 L3）：入口说过“马上会设”以后，点按认领先等它', () => {
  it('等到上下文以后照常认领；等的时候不碰推送订阅（不调 ensurePushSubscription）', async () => {
    vi.useFakeTimers();
    expectPushClaimContext();
    const p = runPushClaim();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ensure).not.toHaveBeenCalled();
    setPushClaimContext(ctx);
    expect(await p).toEqual({ result: 'claimed' });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect((ensure.mock.calls[0]?.[0] as { userId: string }).userId).toBe('u1');
    expect(getPushOutcome()).toEqual({ result: 'claimed' });
  });

  it('等满 PUSH_CLAIM_WAIT_MS（10 秒）还没设：回 claim_failed，没调订阅', async () => {
    vi.useFakeTimers();
    expect(PUSH_CLAIM_WAIT_MS).toBe(10_000);
    expectPushClaimContext();
    let got: unknown = null;
    void runPushClaim().then((o) => {
      got = o;
    });
    await vi.advanceTimersByTimeAsync(PUSH_CLAIM_WAIT_MS - 1);
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual({ result: 'claim_failed' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('等的时候设成 null（换账号、退出）：立刻回 claim_failed，没调订阅', async () => {
    vi.useFakeTimers();
    expectPushClaimContext();
    const p = runPushClaim();
    await vi.advanceTimersByTimeAsync(100);
    setPushClaimContext(null);
    expect(await p).toEqual({ result: 'claim_failed' });
    expect(ensure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没说过“马上会设”、或已经设过：不等，照旧（空就当场 claim_failed，有就当场认领）；显式传参的不等', async () => {
    expect(await runPushClaim()).toEqual({ result: 'claim_failed' });
    setPushClaimContext(ctx);
    expectPushClaimContext();
    expect(await runPushClaim()).toEqual({ result: 'claimed' });
    setPushClaimContext(null);
    expectPushClaimContext();
    expect(await runPushClaim(null)).toEqual({ result: 'claim_failed' });
  });
});
