// 退出这台设备的唯一出口（core/device-exit.ts）：decideExit 的结局表，exitDevice 只执行一次、被移除先经服务器确认
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../boot.ts';
import { decideExit, defaultExitDeps, exitDevice, resetExitForTest, type ExitDeps } from '../device-exit.ts';

afterEach(() => {
  resetExitForTest();
  localStorage.clear();
});

describe('decideExit', () => {
  it('结局表：没确认的被移除只退出；停用、过期只退出；冷静期清库不删会话（注销成功例外）；active 不动', () => {
    expect(decideExit({ reason: 'active' })).toEqual({ act: 'stay' });
    expect(decideExit({ reason: 'removed' })).toMatchObject({ act: 'logout', notice: 'expired', dropSession: true });
    expect(decideExit({ reason: 'removed', fate: 'expired' })).toMatchObject({ act: 'logout', notice: 'expired' });
    expect(decideExit({ reason: 'removed', fate: 'removed' })).toMatchObject({ act: 'logout_wipe', notice: 'removed', dropSession: true });
    expect(decideExit({ reason: 'disabled' })).toMatchObject({ act: 'logout', notice: 'disabled' });
    expect(decideExit({ reason: 'expired' })).toMatchObject({ act: 'logout', notice: 'expired' });
    expect(decideExit({ reason: 'disabled_unsure' })).toMatchObject({ act: 'logout_wipe', dropSession: true });
    expect(decideExit({ reason: 'deletion_unsure' })).toMatchObject({ act: 'logout_wipe', dropSession: true });
    expect(decideExit({ reason: 'pending_deletion' })).toMatchObject({ act: 'logout_wipe', dropSession: false });
    expect(decideExit({ reason: 'pending_deletion', revoked: true })).toMatchObject({ act: 'logout_wipe', dropSession: true });
    expect(decideExit({ reason: 'followed' })).toEqual({ act: 'logout_wipe', notice: null, dropSession: false, broadcast: false });
  });
});

describe('exitDevice', () => {
  const U = '00000000-0000-4000-8000-0000000000a1';
  const S = '00000000-0000-4000-8000-0000000000c1';
  function deps(boot: BootResult | null): ExitDeps {
    return {
      ...defaultExitDeps,
      getBoot: () => boot,
      wipe: vi.fn(async () => undefined),
      clearLocalSessionIf: vi.fn(async () => true),
      clearLogs: vi.fn(),
      broadcastReset: vi.fn(),
      goToAuth: vi.fn(),
      resolveAuthLoss: vi.fn(async () => 'expired' as const),
    };
  }

  it('同一页只执行一次', async () => {
    const boot = { switching: false, userId: U } as BootResult;
    const d = deps(boot);
    await exitDevice({ reason: 'pending_deletion', sid: S, path: 'files' }, d);
    await exitDevice({ reason: 'disabled_unsure', sid: S, path: 'files' }, d);
    expect(d.wipe).toHaveBeenCalledOnce();
    expect(d.goToAuth).toHaveBeenCalledOnce();
  });

  it('被移除：查服务器前已设闸、原因码原样交给判定；服务器没确认就不清库；查的那几秒里再来的信号不处理', async () => {
    const boot = { switching: false, userId: U } as BootResult;
    const d = deps(boot);
    let seen = false;
    d.resolveAuthLoss = vi.fn(async () => ((seen = boot.switching), 'expired' as const));
    const first = exitDevice({ reason: 'removed', sid: S, path: 'sync', code: 'refresh_token_not_found' }, d);
    await exitDevice({ reason: 'disabled_unsure', sid: S, path: 'sync' }, d);
    await first;
    expect(seen).toBe(true);
    expect(d.resolveAuthLoss).toHaveBeenCalledWith({ path: 'sync', code: 'refresh_token_not_found', sessionId: S, userId: U });
    expect(d.wipe).not.toHaveBeenCalled();
    expect(d.goToAuth).toHaveBeenCalledOnce();
    expect(d.goToAuth).toHaveBeenCalledWith('expired', S);
    // 收到时删一次，回登录页前再删一次（旧会话被晚到的令牌刷新写回）
    expect(d.clearLocalSessionIf).toHaveBeenCalledTimes(2);
  });

  it('被移除但写不了记号（账号不是 UUID）：记 auth_loss_store_failed，退回清库', async () => {
    const boot = { switching: false, userId: 'u1' } as BootResult;
    const d = { ...deps(boot), log: vi.fn() };
    await exitDevice({ reason: 'removed', sid: S, path: 'outbox' }, d);
    expect(d.log).toHaveBeenCalledWith('auth_loss_store_failed');
    expect(d.resolveAuthLoss).not.toHaveBeenCalled();
    expect(d.wipe).toHaveBeenCalledOnce();
    expect(d.goToAuth).toHaveBeenCalledWith('removed', S);
  });
});
