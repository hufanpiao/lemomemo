// 注销成功、导出时发现停用或冷静期后离开本机（data/account-exit.ts；R-256 ⑤；架构 0.29 续第 131 条②；TC-B1-98 的客户端部分）
// 和被移除同一套：wipeOnRemoved（设闸 → 清本机库、缓存）→ 清日志队列 → 广播 reset → 只删发请求用的那个会话 → 回登录页带原因
import { describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { createLeaveAccount, type AccountLeaveDeps } from '../data/account-exit.ts';

function deps(boot: Partial<BootResult> | null = { switching: false, userId: 'u1' }) {
  const order: string[] = [];
  const d = {
    getBoot: vi.fn(() => boot as BootResult | null),
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => {
      order.push('wipe');
      await r.clearCacheStorage();
      r.onRemoved();
    }),
    clearCacheStorage: vi.fn(async () => void order.push('caches')),
    clearLogs: vi.fn((u: string | null) => void order.push(`logs:${u}`)),
    broadcastReset: vi.fn((u: string, exit?: { notice: string; sid: string | null }) =>
      void order.push(exit ? `reset:${u}:${exit.notice}:${exit.sid ?? 'null'}` : `reset:${u}`)),
    clearLocalSessionIf: vi.fn((sid: string | null) => void order.push(`session:${sid}`)),
    goToAuth: vi.fn((n: string) => void order.push(`auth:${n}`)),
  } satisfies AccountLeaveDeps;
  return { d, order };
}

describe('createLeaveAccount', () => {
  it('顺序：先广播带退出原因的 reset（DISABLED-probe-later ②）→ 删那个会话、清日志 → wipeOnRemoved（清库、缓存）→ 再清日志 → 广播 reset → 再删一次那个会话 → 回登录页（冷静期）', async () => {
    const { d, order } = deps();
    await createLeaveAccount(d)('pending_deletion', 's-me');
    expect(order).toEqual([
      'reset:u1:pending_deletion:s-me', 'session:s-me', 'logs:u1', 'wipe', 'caches', 'logs:u1', 'reset:u1', 'session:s-me', 'auth:pending_deletion',
    ]);
  });

  it('停用时提示 disabled；只离开一次（再调不清第二遍）', async () => {
    const { d } = deps();
    const leave = createLeaveAccount(d);
    await leave('disabled', 's-me');
    await leave('pending_deletion', 's-me');
    expect(d.wipeOnRemoved).toHaveBeenCalledTimes(1);
    expect(d.goToAuth.mock.calls).toEqual([['disabled']]);
  });

  it('已经在走别的退出流程（boot.switching）：什么也不做', async () => {
    const { d } = deps({ switching: true, userId: 'u1' });
    await createLeaveAccount(d)('pending_deletion', 's-me');
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
  });

  it('没启动过（没有 boot）：删会话、清全部日志队列、回登录页；不广播（不知道是哪个账号）', async () => {
    const { d, order } = deps(null);
    await createLeaveAccount(d)('pending_deletion', 's-me');
    expect(order).toEqual(['session:s-me', 'logs:null', 'logs:null', 'session:s-me', 'auth:pending_deletion']);
  });
});

describe('sid 读不出（null）时删会话（第八轮必改 1：不另认同账号）', () => {
  it('两次删会话都用 clearLocalSessionIf(null)', async () => {
    const { d } = deps();
    await createLeaveAccount(d)('disabled', null);
    expect(d.clearLocalSessionIf.mock.calls).toEqual([[null], [null]]);
  });
});
