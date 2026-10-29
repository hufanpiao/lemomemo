// 告知页收到 account_disabled 先探测再定（R-256 ③、DISABLED-probe-later ①；consent-exit.ts 文件头）：
// record_consent 一路按 is_active() 判断，停用和冷静期都回 account_disabled；探测（platform/account-status.ts 的 exitForDisabled）以后
// pending_deletion → 冷静期提示；disabled → 已停用；removed（signed_out）→ 被移除；unknown → disabled_unsure；active → 不离开、留在告知页
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import type { ExitNotice } from '../../../platform/session.ts';
import { leaveThisDevice, resetLeaveForTest, type LeaveDeps } from '../data/consent-exit.ts';

function deps(answer: () => Promise<ExitNotice | 'active'>, boot: Partial<BootResult> | null = { switching: false, userId: 'U1' }) {
  const order: string[] = [];
  const d: LeaveDeps = {
    getBoot: () => boot as BootResult | null,
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => {
      order.push('wipe');
      await r.clearCacheStorage();
      r.onRemoved();
    }),
    clearCacheStorage: vi.fn(async () => undefined),
    setExitNotice: vi.fn((n) => void order.push(`notice:${n}`)),
    clearLocalSessionIf: vi.fn((sid: string | null) => void order.push(`session:${sid ?? 'null'}`)),
    goToAuth: vi.fn(() => void order.push('auth')),
    clearLogs: vi.fn(() => undefined),
    resolveDisabled: vi.fn(answer),
  };
  return { d, order };
}

afterEach(resetLeaveForTest);

describe('告知页 account_disabled：先探测再定退出原因', () => {
  for (const notice of ['pending_deletion', 'disabled', 'removed', 'disabled_unsure'] as const) {
    it(`探测结果 ${notice}：按它清本机、记原因、回登录页；探测用被拒那次的 sid`, async () => {
      const { d, order } = deps(async () => notice);
      await leaveThisDevice('account_disabled', 's1', d);
      expect(d.resolveDisabled).toHaveBeenCalledWith('s1');
      expect(order).toEqual(['session:s1', 'wipe', `notice:${notice}`, 'session:s1', 'auth']);
    });
  }

  it('探测完以前不删会话、不清本机（探测要用这个会话的令牌）', async () => {
    let answer = (_r: ExitNotice | 'active'): void => undefined;
    const { d, order } = deps(() => new Promise((r) => (answer = r)));
    const p = leaveThisDevice('account_disabled', 's1', d);
    await Promise.resolve();
    expect(order).toEqual([]);
    answer('pending_deletion');
    await p;
    expect(order).toContain('notice:pending_deletion');
  });

  it('active（账号正常）：不清本机、不跳转；之后再遇到可以再处理（不被“只处理一次”挡住）', async () => {
    const { d, order } = deps(async () => 'active');
    await leaveThisDevice('account_disabled', 's1', d);
    expect(order).toEqual([]);
    await leaveThisDevice('session_revoked', 's1', d);
    expect(order).toContain('notice:removed');
    expect(d.goToAuth).toHaveBeenCalledOnce();
  });

  it('探测期间别的退出流程接手了（switching）：什么也不做', async () => {
    const boot = { switching: false, userId: 'U1' };
    let answer = (_r: ExitNotice | 'active'): void => undefined;
    const { d, order } = deps(() => new Promise((r) => (answer = r)), boot);
    const p = leaveThisDevice('account_disabled', 's1', d);
    boot.switching = true;
    answer('disabled');
    await p;
    expect(order).toEqual([]);
  });

  it('session_revoked 不探测，照旧直接按被移除走', async () => {
    const { d } = deps(async () => 'disabled');
    await leaveThisDevice('session_revoked', 's1', d);
    expect(d.resolveDisabled).not.toHaveBeenCalled();
    expect(d.setExitNotice).toHaveBeenCalledWith('removed');
  });

  it('不给 resolveDisabled 时用 exitForDisabled：本机没有会话（拿不到令牌）→ 不探测，按 disabled_unsure', async () => {
    const { d } = deps(async () => 'disabled');
    delete d.resolveDisabled;
    sessionStorage.clear();
    localStorage.clear();
    await leaveThisDevice('account_disabled', 's1', d);
    expect(d.setExitNotice).toHaveBeenCalledWith('disabled_unsure');
  });
});
