// R-382（架构 4.1a 第 1 点 ②）：设置页和插图上传收到 session_revoked 先定结局——expired 只关库、不清，删那一个会话、回登录页“登录已过期”；
// removed 照旧清库。path 记 settings / files。设置页 11-14 起也走这里（createLeaveAccount('removed')，第三方审查前端-4），不再有自己那一份
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { resetExitForTest } from '../../../core/device-exit.ts';
import { createLeaveAccount, defaultAccountLeaveDeps } from '../data/account-exit.ts';

describe('createLeaveAccount(removed) 的 R-382 路径（插图上传 path files）', () => {
  const U = '00000000-0000-4000-8000-0000000000a1';
  const S = '00000000-0000-4000-8000-0000000000c1';
  afterEach(() => {
    resetExitForTest();
    localStorage.clear();
  });
  const base = () => ({
    ...defaultAccountLeaveDeps,
    getBoot: () => ({ switching: false, userId: U }) as BootResult,
    wipe: vi.fn(async (_b: BootResult) => undefined),
    clearLogs: vi.fn(),
    broadcastReset: vi.fn(),
    broadcastWiped: vi.fn(),
    clearLocalSessionIf: vi.fn(async () => true),
    goToAuth: vi.fn(),
  });

  it('判 expired：先写记号再查服务器 → 广播带 expired 的 reset → 删那个会话 → goToAuth(expired)；不清库', async () => {
    const d = base();
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    await createLeaveAccount({ ...d, resolveAuthLoss })('removed', S);
    expect(resolveAuthLoss).toHaveBeenCalledWith({ path: 'files', code: 'session_revoked', sessionId: S, userId: U });
    expect(d.broadcastReset).toHaveBeenCalledWith(U, { notice: 'expired', sid: S });
    expect(d.clearLocalSessionIf).toHaveBeenCalledWith(S);
    expect(d.goToAuth).toHaveBeenCalledWith('expired', S);
    expect(d.wipe).not.toHaveBeenCalled();
  });

  it('判 removed：清库、goToAuth(removed, sid)，清完再发一条不带原因的 reset', async () => {
    const d = base();
    await createLeaveAccount({ ...d, resolveAuthLoss: async () => 'removed' })('removed', S);
    expect(d.wipe).toHaveBeenCalledTimes(1);
    expect(d.goToAuth).toHaveBeenCalledWith('removed', S);
    expect(d.broadcastWiped).toHaveBeenCalledWith(U);
  });

  it('判 expired、第二次写记号会失败（keep 返回 false）：记号在查之前已写好，不再调 keep，不清库，提示登录已过期', async () => {
    const d = base();
    const keep = vi.fn(() => false);
    await createLeaveAccount({ ...d, resolveAuthLoss: async () => 'expired', keep })('removed', S);
    expect(keep).not.toHaveBeenCalled();
    expect(d.wipe).not.toHaveBeenCalled();
    expect(d.goToAuth).toHaveBeenCalledWith('expired', S);
  });

  it('查之前就写不了记号（账号不是 UUID）：退回清库，提示一律 removed（让人知道没上传的改动丢了），不是 expired', async () => {
    const d = { ...base(), getBoot: () => ({ switching: false, userId: 'u1' }) as BootResult };
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    await createLeaveAccount({ ...d, resolveAuthLoss })('removed', S);
    expect(resolveAuthLoss).not.toHaveBeenCalled();
    expect(d.wipe).toHaveBeenCalledTimes(1);
    expect(d.goToAuth).toHaveBeenCalledWith('removed', S);
  });

  it('没启动过（没有 boot）：提示 removed（改前语义）', async () => {
    const d = { ...base(), getBoot: () => null };
    await createLeaveAccount(d)('removed', S);
    expect(d.goToAuth).toHaveBeenCalledWith('removed', S);
  });
});
