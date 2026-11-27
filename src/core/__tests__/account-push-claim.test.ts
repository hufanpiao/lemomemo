// FA6-r3-low N4 / L9：设闸（sealForExit；watchAccount 发现换账号、会话没了，设置页退出流程都走它）时推送认领的上下文一起作废：
// 之后的点按认领、等着上下文的认领都回 claim_failed，上一账号的认领结果清掉
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPushOutcome, setPushOutcome } from '../../platform/push-status.ts';
import { expectPushClaimContext, resetPushClaimForTest, runPushClaim, setPushClaimContext } from '../../platform/push-claim-run.ts';
import type { EnsurePushDeps, EnsurePushOutcome } from '../../platform/push-claim.ts';
import type { BootResult } from '../boot.ts';
import { sealForExit } from '../account.ts';

afterEach(() => {
  resetPushClaimForTest();
  setPushClaimContext(null);
});

const ctx = { userId: 'u1', platform: 'web', claim: vi.fn(), sessionId: () => 's1', currentUserId: () => 'u1' };
const fakeBoot = () => ({ switching: false, outbox: { suspend: vi.fn() }, cache: { seal: vi.fn() } }) as unknown as BootResult;

describe('sealForExit 作废推送认领的上下文', () => {
  it('设闸以后 runPushClaim 回 claim_failed，上一账号的认领结果清掉', async () => {
    setPushClaimContext(ctx);
    setPushOutcome({ result: 'claimed' });
    const boot = fakeBoot();
    sealForExit(boot);
    expect(boot.switching).toBe(true);
    expect(getPushOutcome()).toBeNull();
    expect(await runPushClaim()).toEqual({ result: 'claim_failed' });
  });

  it('首屏画完之前（等着上下文）就设了闸：等着的认领立刻回 claim_failed，不等满 10 秒', async () => {
    vi.useFakeTimers();
    try {
      expectPushClaimContext();
      const p = runPushClaim();
      sealForExit(fakeBoot());
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toEqual({ result: 'claim_failed' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('首屏判断放宽与推送认领核对审查 L2：认领进行到一半（ensureDevice 期间）sealForExit：之后的核对当作不是本人，不调 claim', async () => {
    let devDone!: () => void;
    const devGate = new Promise<void>((r) => (devDone = r));
    const ensureDevice = vi.fn(async () => {
      await devGate;
      return 'dev-1';
    });
    setPushClaimContext({ ...ctx, ensureDevice });
    const claim = vi.fn();
    // 照 push-claim.ts 的 claimOnce：先等设备行，认领前同步比一次会话主人
    const ensure = async (d: EnsurePushDeps): Promise<EnsurePushOutcome> => {
      await d.ensureDevice?.();
      if (d.currentUserId?.() !== d.userId) return { result: 'claim_failed' };
      claim();
      return { result: 'claimed' };
    };
    const p = runPushClaim(undefined, ensure);
    await vi.waitFor(() => expect(ensureDevice).toHaveBeenCalled());
    sealForExit(fakeBoot());
    devDone();
    expect(await p).toEqual({ result: 'claim_failed' });
    expect(claim).not.toHaveBeenCalled();
  });
});
