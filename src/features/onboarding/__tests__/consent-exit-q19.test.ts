// Q-19：告知页点同意时服务器回 session_revoked，必须先经服务器确认（session_fate）才清本机库；没确认只退出、不清库（R-382）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wipeLocal } from '../../../core/account.ts';
import { coldStart, resetBootForTest, type BootResult } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { readReauth } from '../../../platform/auth-loss-store.ts';
import { defaultLeaveDeps, leaveThisDevice, resetLeaveForTest } from '../data/consent-exit.ts';

// 查 session_fate 的分包（core/auth-loss.ts，经 auth-loss-lazy 动态 import）加载失败：发新版后离线时真会这样
vi.mock('../../../core/auth-loss.ts', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const U = '00000000-0000-4000-8000-00000000000a';
const S1 = '00000000-0000-4000-8000-000000000051';

function boot(): BootResult {
  return { switching: false, userId: U, cache: null, outbox: null } as unknown as BootResult;
}

afterEach(() => {
  resetLeaveForTest();
  resetBootForTest();
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

  it('查服务器的分包加载失败（真调用路径、真 UUID、默认 keep 和 resolveAuthLoss）：不清本机库，outbox 还在，不清运行时缓存', async () => {
    const { factory, fake } = fakeIndexedDB();
    const b = await coldStart({
      userId: U, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
      upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    });
    await b.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const clearCacheStorage = vi.fn(async () => undefined);
    const goToAuth = vi.fn();
    await leaveThisDevice('session_revoked', S1, {
      ...defaultLeaveDeps, getBoot: () => b, wipe: (x) => wipeLocal(x, { clearCacheStorage }), goToAuth,
      clearLocalSessionIf: async () => true, clearLogs: vi.fn(), broadcastReset: vi.fn(),
    });
    expect(fake.dbs.get('planner-v4')?.stores.get('outbox')?.records.size).toBe(1);
    expect(clearCacheStorage).not.toHaveBeenCalled();
    expect(readReauth()).toMatchObject({ user_id: U, session_id: S1 });
    expect(goToAuth).toHaveBeenCalledWith('expired', S1);
  });
});
