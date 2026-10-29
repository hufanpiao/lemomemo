// 本页的 SIGNED_OUT（刷新失败、被移除、被退出；K6-signedout，TC-B1-61 ②、TC-B1-83）。
// K6-sugg5 ⑤ 从 account-watch.test.ts 按主题拆出来；搭台在 account-watch-harness.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchAccount } from '../account.ts';
import { coldStart, getBoot, resetBootForTest } from '../boot.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB, flush } from './idb-fake.ts';
import { setup } from './account-watch-harness.ts';

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
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
