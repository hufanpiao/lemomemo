// R-382 复核建议 ②：另一个标签页 B 本人手动退出时，A 页 sid 为 null 的 account_disabled 那条路（R-263）不能写下 lemo.reauth——
// 否则 B 退出时删掉记号以后 A 又写一份，没人再删，下次冷启动误报“登录已过期”。
// 顺序（复现用）：B 打本人退出标记（lemo.self_signout）、删记号、删会话键（localStorage 同步生效）→ A 的 storage 事件还没到时，
// A 在路上的请求（发出时本机已没有会话，sid 为 null）回了 account_disabled → 之后 A 才收到 storage 事件（watchAccount 那一路）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { claimCache } from '../../core/account.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB, flush } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { clearReauth, readReauth } from '../../platform/auth-loss-store.ts';
import { markSelfSignOut, resetSelfSignOutForTest } from '../../platform/session.ts';
import { wireSync } from '../sync-wiring.ts';
import { watchWithExit } from '../../core/__tests__/account-watch-harness.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

async function start() {
  const { factory } = fakeIndexedDB();
  const boot = await coldStart(opts(factory));
  if (!boot.cache) throw new Error('no cache');
  await claimCache(boot.cache, A);
  let sessionUser: string | null = A;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync;
  const d = {
    transport: fakeTransport(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSessionIf: vi.fn(),
    resolveAuthLoss: vi.fn(() => Promise.resolve('expired' as const)),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn((_n: string, _sid?: string | null) => undefined),
    readExitNotice: vi.fn((): null => null),
    readUserId: vi.fn(() => sessionUser),
    clearLogs: vi.fn(),
    log: vi.fn((..._a: unknown[]) => undefined),
    create: (_b: BootResult, _o: SyncOptions) => sync,
  };
  wireSync(boot, d);
  let storageFn: (id: string | null) => void = () => undefined;
  const w = {
    onAuthUser: () => () => undefined,
    onStorageUser: (fn: (id: string | null) => void) => ((storageFn = fn), () => undefined),
    currentUserId: () => sessionUser,
    dropSession: () => null,
    onSignedOut: vi.fn(),
    onSwitched: vi.fn(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
  };
  watchWithExit(boot, w);
  /** B 页本人退出：打标记、删记号（signOutThisDevice 的顺序）、最后会话键没了 */
  const otherTabSignsOut = (): void => {
    markSelfSignOut(undefined, Date.now(), S);
    resetSelfSignOutForTest();   // 标记是 B 页打的：A 页内存里没有，只剩 localStorage 那份
    clearReauth();
    sessionUser = null;
  };
  return { boot, d, w, otherTabSignsOut, storageEvent: () => storageFn(null) };
}

async function failWith(boot: BootResult, code: string, sid: string | null): Promise<void> {
  const ob = boot.outbox;
  if (!ob) throw new Error('outbox');
  await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
  const a = await ob.next();
  await ob.fail(a?.op_id ?? '', { status: 403, code, sid });
}

beforeEach(() => clearAllCollections());
afterEach(() => {
  resetSelfSignOutForTest();
  localStorage.clear();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('别的标签页本人退出（R-382 复核建议 ②）', () => {
  it('sync-wiring-other-tab-signout：storage 事件到之前先收到 sid 为 null 的 account_disabled → 不留 lemo.reauth，下次冷启动不误报“登录已过期”；随后的 storage 事件不再退第二遍', async () => {
    const r = await start();
    r.otherTabSignsOut();
    await failWith(r.boot, 'account_disabled', null);
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalled());
    r.storageEvent();
    await flush(20);
    // 同一页只退出一次（core/device-exit.ts 的 exited）：同步层已经在退出，watchAccount 那一路什么也不做
    expect(r.w.onSignedOut).not.toHaveBeenCalled();
    expect(r.d.goToAuth).toHaveBeenCalledTimes(1);
    expect(readReauth()).toBeNull();
    expect(r.d.setExitNotice).not.toHaveBeenCalled();
  });

  it('没有本人退出标记（本页会话自己没了）：照旧只关库、写记号、提示 expired（R-263 ③ 不变）', async () => {
    const r = await start();
    r.d.readUserId.mockReturnValue(null);
    await failWith(r.boot, 'account_disabled', null);
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(readReauth()).toMatchObject({ user_id: A, session_id: null });
    expect(r.d.setExitNotice).toHaveBeenCalledWith('expired', null);
  });
});
