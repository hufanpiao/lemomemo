// 换账号的事件时机（架构 4.1、0.38 第 17 条；K6 审查 M1、M2、M3、L3）：SIGNED_IN、TOKEN_REFRESHED、别的标签页的 storage 事件、
// 挂上监听后再比一次（补上 coldStart 期间漏掉的事件）；同步设闸；清完关库；清库失败即关；本机库打不开时也重来；被移除
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheOwner, claimCache, watchAccount, wipeOnRemoved, type WatchAccountDeps } from '../account.ts';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../boot.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { count, freshCache, seedA } from './account-fixtures.ts';
import { FakeObjectStore } from './idb-fake-tx.ts';
import { fakeIndexedDB, flush } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

type Fire<T> = (v: T) => void;

interface Setup {
  boot: BootResult;
  factory: IDBFactory;
  deps: WatchAccountDeps;
  auth: Fire<string>;
  storage: Fire<string | null>;
  /** coldStart 期间会话被改成了什么（挂上监听后再比一次时读到的值） */
  session: { id: string | null };
}

async function setup(opts: { sessionAfterBoot?: string | null; openFails?: boolean } = {}): Promise<Setup> {
  const { factory } = fakeIndexedDB();
  const boot = await coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: opts.openFails ? { factory: undefined as unknown as IDBFactory, name: 'x' } : { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  if (boot.cache) {
    await seedA(boot.cache);
    await boot.outbox?.refresh();
  }
  const session = { id: opts.sessionAfterBoot === undefined ? 'A' : opts.sessionAfterBoot };
  const handlers: { auth: Fire<string>; storage: Fire<string | null> } = { auth: () => undefined, storage: () => undefined };
  const deps: WatchAccountDeps = {
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    onAuthUser: (fn) => {
      handlers.auth = fn;
      return () => undefined;
    },
    onStorageUser: (fn) => {
      handlers.storage = fn;
      return () => undefined;
    },
    currentUserId: () => session.id,
    onSignedOut: vi.fn(),
    onSwitched: vi.fn(),
    onFailed: vi.fn(),
  };
  watchAccount(boot, deps);
  return { boot, factory, deps, session, auth: (v) => handlers.auth(v), storage: (v) => handlers.storage(v) };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('watchAccount：登录、刷新令牌、别的标签页', () => {
  it('TOKEN_REFRESHED 还是同一个人：不清、不设闸', async () => {
    const { boot, deps, auth } = await setup();
    auth('A');
    await flush(20);
    expect(deps.onSwitched).not.toHaveBeenCalled();
    expect(boot.switching).toBe(false);
    expect(await count(boot.cache as never)).toBe(4);
  });

  it('SIGNED_IN 成了 B：当场设闸（enqueue 拒收、next 为空）→ 清空 A 的一切（outbox 不发）→ 清运行时缓存 → 关库 → 重新载入', async () => {
    const { boot, factory, deps, auth } = await setup();
    expect(boot.outbox?.getStatus().pending).toBe(1);
    auth('B');
    // 同步设闸：还没 await 任何东西
    expect(boot.switching).toBe(true);
    expect(boot.outbox?.isSuspended()).toBe(true);
    await expect(boot.outbox?.enqueue({ table: 'todos', id: uid(9), op: 'insert', data: todo(9) })).rejects.toBeInstanceOf(OutboxRejectError);
    expect(await boot.outbox?.next()).toBeNull();
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(boot.cache?.isClosed()).toBe(true);
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(boot).toMatchObject({ switchedUser: true, flags: null });
    expect(boot.fullResync.length).toBe(9);
    const reopened = await freshCache(factory);
    expect(await count(reopened)).toBe(0);
    expect(await cacheOwner(reopened)).toBe('B');
    reopened.close();
  });

  it('别的标签页换成 B，本页随后又收到 SIGNED_IN：只处理一次', async () => {
    const { deps, storage, auth } = await setup();
    storage('B');
    auth('B');
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    await flush(20);
    expect(deps.onSwitched).toHaveBeenCalledTimes(1);
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
  });

  it('别的标签页已经清过（owner 已是 B）：本页不再清 Cache Storage，照样关库、重新载入', async () => {
    const { boot, factory, deps, storage } = await setup();
    const other = await freshCache(factory);
    const otherClaim = claimCache(other, 'B');
    storage('B');
    await otherClaim;
    other.close();
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.clearCacheStorage).not.toHaveBeenCalled();
    expect(boot.cache?.isClosed()).toBe(true);
  });

  it('别的标签页退出了：设闸、去登录页，不清库（退出流程自己清）', async () => {
    const { boot, deps, storage } = await setup();
    storage(null);
    expect(boot.switching).toBe(true);
    expect(deps.onSignedOut).toHaveBeenCalledTimes(1);
    expect(deps.onSwitched).not.toHaveBeenCalled();
    expect(await count(boot.cache as never)).toBe(4);
  });

  it('M1：coldStart 期间别的标签页换成了 B（storage 事件发生在挂监听之前、漏掉了）：挂上后再比一次照样换', async () => {
    const { boot, deps } = await setup({ sessionAfterBoot: 'B' });
    expect(boot.switching).toBe(true);
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
  });

  it('M1：coldStart 期间别的标签页退出了：挂上后再比一次，去登录页', async () => {
    const { deps } = await setup({ sessionAfterBoot: null });
    expect(deps.onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('M3：换账号时清库抛错 → 关库、集合清空、onFailed（不当成成功）', async () => {
    const { boot, deps, auth } = await setup();
    vi.spyOn(FakeObjectStore.prototype, 'clear').mockImplementation(() => {
      throw new DOMException('disk', 'QuotaExceededError');
    });
    auth('B');
    await vi.waitFor(() => expect(deps.onFailed).toHaveBeenCalledTimes(1));
    expect(deps.onSwitched).not.toHaveBeenCalled();
    expect(boot.cache?.isClosed()).toBe(true);
    expect(boot.switching).toBe(true);
  });

  it('L3：本机库打不开（unavailable）时换了账号：照样清运行时缓存、重新载入', async () => {
    const { boot, deps, auth } = await setup({ openFails: true });
    expect(boot.status).toBe('unavailable');
    expect(boot.userId).toBe('A');
    auth('B');
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
  });
});

describe('被移除（session_revoked、account_disabled）', () => {
  it('fail 归成 removed：设闸、发 removed 事件；wipeOnRemoved 清空本机、关库、onRemoved', async () => {
    const { boot } = await setup();
    const events: string[] = [];
    boot.outbox?.onEvent((e) => events.push(e.type));
    const item = await boot.outbox?.enqueue({ table: 'todos', id: uid(5), op: 'insert', data: todo(5) });
    const sent = await boot.outbox?.next();
    expect(sent?.op_id).toBeDefined();
    expect(await boot.outbox?.fail(item?.op_id ?? '', { status: 401, code: 'session_revoked' })).toBe('removed');
    expect(boot.outbox?.isSuspended()).toBe(true);
    expect(events).toEqual(['removed']);
    const onRemoved = vi.fn();
    const clearCaches = vi.fn(() => Promise.resolve());
    const cache = boot.cache;
    await wipeOnRemoved(boot, { clearCacheStorage: clearCaches, onRemoved });
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(clearCaches).toHaveBeenCalledTimes(1);
    expect(cache?.isClosed()).toBe(true);
  });
});
