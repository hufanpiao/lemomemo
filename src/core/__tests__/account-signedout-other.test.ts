// K6-sugg5 ③ 组合用例：本机已是别的账号 B 的会话 S2 时，收到转来的（A 的会话 S1 的）SIGNED_OUT。
// ① platform 的 authEventHandler：本页最后见到的是 S1、本机已是 S2 → 不回调 onSignedOut，改认 S2（K6-sugg4 ④）
// ② 万一转到了 watchAccount（signedOutHere）：会话里已是 B → 按换账号处理（claimCache、onSwitched），不删会话、不按“被移除”回登录页
// 两条合起来固定 K6-sugg4 ④ 的前提：换账号清库走 storage 事件 / 换账号那一路，SIGNED_OUT 不会把 B 的新会话删掉
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authEventHandler } from '../../platform/session.ts';
import { watchAccount, type WatchAccountDeps } from '../account.ts';
import { coldStart, getBoot, resetBootForTest } from '../boot.ts';
import { clearAllCollections } from '../store.ts';
import { seedA } from './account-fixtures.ts';
import { fakeIndexedDB, flush } from './idb-fake.ts';

beforeEach(() => clearAllCollections());
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('本机已是别的账号的 S2 时收到转来的 SIGNED_OUT', () => {
  it('① authEventHandler：不回调 onSignedOut（不删 S2、不清库），改认 S2；之后 S2 自己的 SIGNED_OUT 照常回调', () => {
    let local: string | null = 's2';
    const out = vi.fn();
    const h = authEventHandler(vi.fn(), out, { selfSignOut: () => false, initialSessionId: 's1', localSessionId: () => local });
    h('SIGNED_OUT', null);
    expect(out).not.toHaveBeenCalled();
    local = null;
    h('SIGNED_OUT', null);
    expect(out).toHaveBeenCalledWith('s2');
  });

  it('② 转到了 watchAccount：会话里已是 B → 换账号（switchedUser、onSwitched），不删会话、不按“被移除”回登录页', async () => {
    const { factory } = fakeIndexedDB();
    const boot = await coldStart({
      userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
      upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    });
    if (boot.cache) await seedA(boot.cache);
    let signedOut: (sid?: string | null) => void = () => undefined;
    let current: string | null = 'A';
    const deps: WatchAccountDeps = {
      clearCacheStorage: vi.fn(() => Promise.resolve()),
      onAuthUser: (_fn, so) => {
        if (so) signedOut = so;
        return () => undefined;
      },
      onStorageUser: () => () => undefined,
      currentUserId: () => current,
      dropSession: vi.fn((): string | null => 's2'),
      onSignedOut: vi.fn(),
      clearLogs: vi.fn(),
      onSwitched: vi.fn(),
      onFailed: vi.fn(),
    };
    watchAccount(boot, deps);
    current = 'B';
    signedOut('s1');
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.dropSession).not.toHaveBeenCalled();
    expect(deps.onSignedOut).not.toHaveBeenCalled();
    expect(boot.switchedUser).toBe(true);
    await flush(5);
    expect(deps.onSignedOut).not.toHaveBeenCalled();
  });
});
