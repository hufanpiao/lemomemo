// Q-19：告知页点同意时服务器回 session_revoked，必须先经服务器确认（session_fate）才清本机库；没确认只退出、不清库（R-382）
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { readReauth } from '../../../platform/auth-loss-store.ts';
import { defaultLeaveDeps, leaveThisDevice, resetLeaveForTest } from '../data/consent-exit.ts';

const U = '00000000-0000-4000-8000-00000000000a';
const S1 = '00000000-0000-4000-8000-000000000051';

function boot(): BootResult {
  return { switching: false, userId: U, cache: null, outbox: null } as unknown as BootResult;
}

afterEach(() => {
  resetLeaveForTest();
  localStorage.clear();
});

describe('Q-19 告知页 session_revoked', () => {
  it('服务器没确认被移除（session_fate 不是 revoked）：不清本机库，只退出，提示登录已过期', async () => {
    const wipe = vi.fn(async () => undefined);
    const goToAuth = vi.fn();
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    const b = boot();
    await leaveThisDevice('session_revoked', S1, {
      getBoot: () => b, wipe, resolveAuthLoss, goToAuth, keep: defaultLeaveDeps.keep,
      clearLocalSessionIf: async () => true,
      clearLogs: vi.fn(), broadcastReset: vi.fn(),
    });
    expect(resolveAuthLoss).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_revoked', sessionId: S1, userId: U }));
    expect(wipe).not.toHaveBeenCalled();
    expect(readReauth()).toMatchObject({ user_id: U, session_id: S1 });   // 只退出：记号留着，登录页提示登录已过期
    expect(goToAuth).toHaveBeenCalledWith('expired', S1);
  });

  it('服务器确认被移除（session_fate 回 revoked）：清本机库，提示被移除', async () => {
    const wipe = vi.fn(async () => undefined);
    const goToAuth = vi.fn();
    const b = boot();
    await leaveThisDevice('session_revoked', S1, {
      getBoot: () => b, wipe, resolveAuthLoss: async () => 'removed' as const, goToAuth, keep: defaultLeaveDeps.keep,
      clearLocalSessionIf: async () => true, clearLogs: vi.fn(), broadcastReset: vi.fn(),
    });
    expect(wipe).toHaveBeenCalledOnce();
    expect(goToAuth).toHaveBeenCalledWith('removed', S1);
  });
});
