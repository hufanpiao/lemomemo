// 告知页里会话不认、账号停用时离开这台设备（CONSENT-wire ④；架构 4.1、4.3 ②）：调现有出口 wipeOnRemoved，清完记退出原因、删会话、回登录页；
// 原因按码：session_revoked → removed，account_disabled → disabled；已经在走别的退出流程（switching）不再走；只处理一次；
// 这个账号的日志上传队列清库前清一次、回登录页前再清一次（0.38 第 68 条 ⑤，审查 M1），没启动过时清全部
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { logQueueKey } from '../../../platform/log-store.ts';
import { defaultLeaveDeps, leaveThisDevice, resetLeaveForTest, type LeaveDeps } from '../data/consent-exit.ts';

function deps(boot: Partial<BootResult> | null) {
  const order: string[] = [];
  const d: LeaveDeps = {
    getBoot: () => boot as BootResult | null,
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => {
      order.push('wipe');
      await r.clearCacheStorage();
      r.onRemoved();
    }),
    clearCacheStorage: vi.fn(async () => {
      order.push('caches');
    }),
    setExitNotice: vi.fn((n) => {
      order.push(`notice:${n}`);
    }),
    clearLocalSession: vi.fn(() => {
      order.push('session');
    }),
    goToAuth: vi.fn(() => {
      order.push('auth');
    }),
    clearLogs: vi.fn((userId: string | null) => {
      order.push(`logs:${userId ?? '*'}`);
    }),
  };
  return { d, order };
}

afterEach(resetLeaveForTest);

describe('leaveThisDevice', () => {
  it('会话不认：清本机（wipeOnRemoved）→ 记 removed → 删会话 → 回登录页', async () => {
    const { d, order } = deps({ switching: false, userId: 'U1' });
    await leaveThisDevice('session_revoked', d);
    expect(order).toEqual(['logs:U1', 'wipe', 'caches', 'logs:U1', 'notice:removed', 'session', 'auth']);
  });

  it('账号停用：同一套，退出原因记 disabled（登录页 auth.exit.disabled）', async () => {
    const { d, order } = deps({ switching: false, userId: 'U1' });
    await leaveThisDevice('account_disabled', d);
    expect(order).toEqual(['logs:U1', 'wipe', 'caches', 'logs:U1', 'notice:disabled', 'session', 'auth']);
  });

  it('没启动过（没有 boot）：不清库，直接记原因、删会话、回登录页', async () => {
    const { d, order } = deps(null);
    await leaveThisDevice('account_disabled', d);
    expect(order).toEqual(['logs:*', 'logs:*', 'notice:disabled', 'session', 'auth']);
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
  });

  it('已经在走别的退出流程（switching）：什么也不做', async () => {
    const { d, order } = deps({ switching: true });
    await leaveThisDevice('session_revoked', d);
    expect(order).toEqual([]);
  });

  it('只处理一次：连着来两次只清一遍、只跳一次', async () => {
    const { d } = deps({ switching: false, userId: 'U1' });
    await Promise.all([leaveThisDevice('session_revoked', d), leaveThisDevice('account_disabled', d)]);
    expect(d.wipeOnRemoved).toHaveBeenCalledOnce();
    expect(d.goToAuth).toHaveBeenCalledOnce();
    expect(d.setExitNotice).toHaveBeenCalledWith('removed');
  });

  it('默认的 clearLogs 真的删掉 localStorage 里的队列：有账号只删这个账号的，null 删全部 lemo.logq.*', () => {
    localStorage.setItem(logQueueKey('U1'), '[]');
    localStorage.setItem(logQueueKey('U2'), '[]');
    localStorage.setItem('other', 'x');
    defaultLeaveDeps.clearLogs('U1');
    expect(localStorage.getItem(logQueueKey('U1'))).toBeNull();
    expect(localStorage.getItem(logQueueKey('U2'))).toBe('[]');
    defaultLeaveDeps.clearLogs(null);
    expect(localStorage.getItem(logQueueKey('U2'))).toBeNull();
    expect(localStorage.getItem('other')).toBe('x');
    localStorage.removeItem('other');
  });
});
