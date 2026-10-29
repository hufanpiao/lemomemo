// 换账号的事件时机（架构 4.1、0.38 第 17 条；K6 审查 M1、M2、M3、L3）：SIGNED_IN、TOKEN_REFRESHED、别的标签页的 storage 事件、
// 挂上监听后再比一次（补上 coldStart 期间漏掉的事件）；同步设闸；清完关库；清库失败即关；本机库打不开时也重来；被移除；
// 本页的 SIGNED_OUT（K6-signedout，TC-B1-61 ②、TC-B1-83）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheOwner, claimCache, watchAccount, wipeOnRemoved, type WatchAccountDeps } from '../account.ts';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../boot.ts';
import { deleteCacheDb } from '../cache.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { count, freshCache, seedA } from './account-fixtures.ts';
import { FakeObjectStore } from './idb-fake-tx.ts';
import { fakeIndexedDB, flush, type FakeIDBFactory } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

type Fire<T> = (v: T) => void;

interface Setup {
  boot: BootResult;
  factory: IDBFactory;
  deps: WatchAccountDeps;
  auth: Fire<string>;
  storage: Fire<string | null>;
  /** 本页的 SIGNED_OUT（onAuthUser 的第二个回调；platform 已滤掉自己退出的） */
  signedOut: () => void;
  /** coldStart 期间会话被改成了什么（挂上监听后再比一次时读到的值） */
  session: { id: string | null };
  fake: FakeIDBFactory;
  /** 升级中心的重新载入（versionchange → 重新载入；退出删库不能触发它） */
  reload: ReturnType<typeof vi.fn>;
}

async function setup(opts: { sessionAfterBoot?: string | null; openFails?: boolean } = {}): Promise<Setup> {
  const { factory, fake } = fakeIndexedDB();
  const reload = vi.fn();
  const boot = await coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: opts.openFails ? { factory: undefined as unknown as IDBFactory, name: 'x' } : { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  if (boot.cache) {
    await seedA(boot.cache);
    await boot.outbox?.refresh();
  }
  const session = { id: opts.sessionAfterBoot === undefined ? 'A' : opts.sessionAfterBoot };
  const handlers: { auth: Fire<string>; storage: Fire<string | null>; signedOut: () => void } = {
    auth: () => undefined, storage: () => undefined, signedOut: () => undefined,
  };
  const deps: WatchAccountDeps = {
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    onAuthUser: (fn, onSignedOut) => {
      handlers.auth = fn;
      if (onSignedOut) handlers.signedOut = onSignedOut;
      return () => undefined;
    },
    onStorageUser: (fn) => {
      handlers.storage = fn;
      return () => undefined;
    },
    currentUserId: () => session.id,
    dropSession: vi.fn((): string | null => null),
    onSignedOut: vi.fn(),
    clearLogs: vi.fn(),
    onSwitched: vi.fn(),
    onFailed: vi.fn(),
    deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }),
  };
  watchAccount(boot, deps);
  return {
    boot, factory, deps, session, fake, reload,
    auth: (v) => handlers.auth(v), storage: (v) => handlers.storage(v), signedOut: () => handlers.signedOut(),
  };
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

  it('别的标签页退出了：同步设闸；清空并关掉本页连接、按库名删库、清运行时缓存，再去登录页；不触发 versionchange → 重新载入', async () => {
    const { boot, deps, storage, fake, reload } = await setup();
    expect(fake.dbs.has('planner-v4')).toBe(true);
    storage(null);
    expect(boot.switching).toBe(true);
    expect(deps.onSignedOut).not.toHaveBeenCalled();   // 清完才走
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(fake.dbs.has('planner-v4')).toBe(false);
    expect(boot.cache?.isClosed()).toBe(true);
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(deps.onSwitched).not.toHaveBeenCalled();
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(boot.upgrade.getState().cache).toBe('ok');
  });

  it('别的标签页退出、库被别的连接挡着删不掉：内容已清空，照样去登录页', async () => {
    const { boot, deps, storage, fake } = await setup();
    // 模拟另一个还开着库、不响应 versionchange 的标签页
    const raw = fake.open('planner-v4');
    await new Promise<void>((r) => (raw.onsuccess = () => r()));
    storage(null);
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(boot.cache?.isClosed()).toBe(true);
    const stores = fake.dbs.get('planner-v4')?.stores;
    expect(stores?.get('todos')?.records.size).toBe(0);
    expect(stores?.get('outbox')?.records.size).toBe(0);
    (raw.result as { close(): void }).close();
    await flush();
    expect(fake.dbs.has('planner-v4')).toBe(false);   // 挡着的关了，排队的删除接着完成
  });

  it('别的标签页退出、按库名删库的请求永远不触发事件：按时放弃（blocked），照样调到 onSignedOut', async () => {
    const { boot, deps, storage } = await setup();
    const stuck = { deleteDatabase: () => ({}) } as unknown as IDBFactory;
    deps.deleteDb = () => deleteCacheDb({ factory: stuck, waitMs: 30 });
    storage(null);
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(boot.cache?.isClosed()).toBe(true);
  });

  it('M1：coldStart 期间别的标签页换成了 B（storage 事件发生在挂监听之前、漏掉了）：挂上后再比一次照样换', async () => {
    const { boot, deps } = await setup({ sessionAfterBoot: 'B' });
    expect(boot.switching).toBe(true);
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
  });

  it('M1：coldStart 期间别的标签页退出了：挂上后再比一次，清库后去登录页', async () => {
    const { deps, fake } = await setup({ sessionAfterBoot: null });
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(fake.dbs.has('planner-v4')).toBe(false);
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

describe('本页的 SIGNED_OUT（刷新失败、被移除、被退出；K6-signedout）', () => {
  it('和 SIGNED_IN 同一个监听：watchAccount 只调一次 onAuthUser，第二个回调就是 SIGNED_OUT', async () => {
    const onAuthUser = vi.fn((_fn: (id: string) => void, _so?: () => void) => () => undefined);
    const { boot } = await setup();
    boot.cache?.close();
    resetBootForTest();
    const b2 = await coldStart({ userId: 'A', appVersion: '4.0.0', cacheOptions: { factory: fakeIndexedDB().factory }, listen426: false });
    watchAccount(b2, {
      clearCacheStorage: () => Promise.resolve(), onAuthUser, onStorageUser: () => () => undefined,
      currentUserId: () => 'A', dropSession: () => null, onSignedOut: vi.fn(), onSwitched: vi.fn(),
    });
    expect(onAuthUser).toHaveBeenCalledTimes(1);
    expect(typeof onAuthUser.mock.calls[0]?.[1]).toBe('function');
    b2.cache?.close();
  });

  it('不是自己退出：同步设闸 → 清空整库（含 outbox、草稿）→ 关库 → 按库名删库 → 清运行时缓存 → 清日志队列 → onSignedOut（removed）', async () => {
    const { boot, deps, signedOut, session, fake, reload } = await setup();
    session.id = null;   // supabase-js 发 SIGNED_OUT 前已删掉本机会话
    expect(fake.dbs.has('planner-v4')).toBe(true);
    expect(boot.outbox?.getStatus().pending).toBe(1);
    signedOut();
    // 同步设闸：还没 await 任何东西
    expect(boot.switching).toBe(true);
    expect(boot.outbox?.isSuspended()).toBe(true);
    expect(deps.clearLogs).toHaveBeenCalledTimes(1);
    expect(deps.onSignedOut).not.toHaveBeenCalled();   // 清完才走
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(deps.onSignedOut).toHaveBeenCalledWith('removed', null);
    expect(fake.dbs.has('planner-v4')).toBe(false);
    expect(boot.cache?.isClosed()).toBe(true);
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(deps.onSwitched).not.toHaveBeenCalled();
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });

  it('本机会话还读得到同一个账号（别的标签页刷新令牌写回）也按被移除处理', async () => {
    const { deps, signedOut } = await setup();
    signedOut();
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledWith('removed', null));
  });

  it('删库、清缓存失败也照样回登录页', async () => {
    const { deps, signedOut, session } = await setup();
    session.id = null;
    deps.deleteDb = () => Promise.reject(new Error('blocked'));
    deps.clearCacheStorage = vi.fn(() => Promise.reject(new Error('x')));
    deps.clearLogs = vi.fn(() => {
      throw new Error('quota');
    });
    signedOut();
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledWith('removed', null));
  });

  it('只处理一次：随后的 storage(null)、再一次 SIGNED_OUT 都不再清、不再跳', async () => {
    const { deps, signedOut, storage, session } = await setup();
    session.id = null;
    signedOut();
    storage(null);
    signedOut();
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    await flush(20);
    expect(deps.onSignedOut).toHaveBeenCalledTimes(1);
    expect(deps.clearCacheStorage).toHaveBeenCalledTimes(1);
  });

  it('别的标签页先退出（storage null）再转来 SIGNED_OUT：按普通退出，不带“被移除”', async () => {
    const { deps, signedOut, storage, session } = await setup();
    session.id = null;
    storage(null);
    signedOut();
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
    expect(deps.onSignedOut).toHaveBeenCalledWith();
    expect(deps.clearLogs).not.toHaveBeenCalled();
  });

  it('已经在走别的退出流程（自己退出的 sealForExit、wipeOnRemoved 设过闸）：不再清第二遍、不跳', async () => {
    const { boot, deps, signedOut, session } = await setup();
    session.id = null;
    boot.switching = true;
    signedOut();
    await flush(20);
    expect(deps.onSignedOut).not.toHaveBeenCalled();
    expect(deps.clearCacheStorage).not.toHaveBeenCalled();
    expect(deps.clearLogs).not.toHaveBeenCalled();
    expect(boot.cache?.isClosed()).toBe(false);
  });

  it('复查建议 ①：dropSession 在判断会话之后、设闸之前同步调，删掉的 session_id 原样交给 onSignedOut；抛错时交 null', async () => {
    const { deps, signedOut, session } = await setup();
    session.id = null;
    deps.dropSession = vi.fn(() => 's1');
    signedOut();
    expect(deps.dropSession).toHaveBeenCalledTimes(1);   // 同步：还没 await 任何东西
    await vi.waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledWith('removed', 's1'));
    const t2 = await setup();
    t2.session.id = null;
    t2.deps.dropSession = () => {
      throw new Error('denied');
    };
    t2.signedOut();
    await vi.waitFor(() => expect(t2.deps.onSignedOut).toHaveBeenCalledWith('removed', null));
  });

  it('换账号那条路（会话里已是 B）不调 dropSession：会话是 B 的，不能删', async () => {
    const { deps, signedOut, session } = await setup();
    session.id = 'B';
    deps.dropSession = vi.fn(() => null);
    signedOut();
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.dropSession).not.toHaveBeenCalled();
  });

  it('会话里已经是别的账号（别的标签页刚登录 B）：按换账号处理（清库、重新载入），不提示被移除', async () => {
    const { deps, signedOut, session } = await setup();
    session.id = 'B';
    signedOut();
    await vi.waitFor(() => expect(deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(deps.onSignedOut).not.toHaveBeenCalled();
  });
});

// K6-sugg4 ②：onSignedOut 带 removed 时必须带 session_id（typecheck 检查；不执行）
function signedOutShapes(d: WatchAccountDeps): void {
  // @ts-expect-error 带 removed 不带 session_id
  d.onSignedOut('removed');
  d.onSignedOut();
  d.onSignedOut('removed', null);
}

it('K6-sugg4 ②：不给 session_id 的调用编不过（上面的 @ts-expect-error，由 typecheck 检查）', () => {
  expect(typeof signedOutShapes).toBe('function');
});
