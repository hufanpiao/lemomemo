// 设置页清空本机走真的 core（假 IndexedDB）：K9 第三轮 M1
// • 清理一开始先 sealForExit 同步设闸：之后离线队列的 ack、fail 不再写库（不会把清掉的行、队列项写回来）
// • 计数（localUnsentCount）要在封存之前调：封存以后数不出来（null）
// • 清库卡住、改按库名删库时，本页不能因为自己删库收到 versionchange 而 reload（打断 signOut，留下“有会话、没库”）（K-signout-merge 复审 M1）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../../../core/boot.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { seed, todo, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { DELETE_WAIT_MS, signOutThisDevice } from '../../../platform/sign-out.ts';
import { defaultExitDeps } from '../data/local.ts';

async function boot(factory: IDBFactory = fakeIndexedDB().factory, reload = vi.fn()): Promise<BootResult> {
  return coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

type FakeConn = { closed?: boolean; version?: number; close?: () => void; onversionchange?: ((e: { oldVersion: number; newVersion: number | null }) => void) | null };

/**
 * core 的假 IndexedDB 没有 deleteDatabase：按浏览器的做法补上——先给还开着的连接发 versionchange，
 * 还有没关的就 blocked（一直等），都关了才删
 */
function withDeleteDatabase(inner: IDBFactory) {
  const opened: { result?: unknown }[] = [];
  const deleted: string[] = [];
  const conns = (): FakeConn[] => opened.map((r) => r.result as FakeConn | undefined).filter((c): c is FakeConn => !!c && !c.closed);
  const factory = {
    open: (name: string, version?: number) => {
      const req = inner.open(name, version);
      opened.push(req);
      return req;
    },
    deleteDatabase: (name: string) => {
      const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      setTimeout(() => {
        for (const c of conns()) c.onversionchange?.({ oldVersion: c.version ?? 1, newVersion: null });
        if (conns().length > 0) {
          req.onblocked?.();
          return;
        }
        deleted.push(name);
        req.onsuccess?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, deleted, conns };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('退出时清空本机（真 core）', () => {
  it('先数（封存前能数出来），清理开始就设闸：之后 ack、fail 不再写库，清完库里什么也不剩', async () => {
    const b = await boot();
    const { cache, outbox } = b;
    if (!cache || !outbox) throw new Error('boot');
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改' } });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    const sending = await outbox.next();
    if (!sending) throw new Error('next');

    // 计数在封存之前：数得出来
    expect(await defaultExitDeps.pendingCount()).toBe(2);

    // 清理开始：wipe 一调用就同步设闸（不用等它做完）
    const wiping = defaultExitDeps.wipe?.();
    expect(b.switching).toBe(true);
    expect(outbox.isSuspended()).toBe(true);
    expect(cache.isSealed()).toBe(true);
    // 清理进行中，正在发的那一项的响应回来了
    await outbox.ack(sending.op_id, { status: 'ok', rev: 6, prev_rev: 5 });
    await outbox.fail(sending.op_id, { status: 400 });
    await wiping;
    // 清完之后又晚到一次
    await outbox.ack(sending.op_id, { status: 'ok', rev: 7, prev_rev: 6 });
    await outbox.fail(sending.op_id, { network: true });

    expect(await outbox.list()).toEqual([]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await cache.getRow('todos', uid(2))).toBeUndefined();
    // 封存以后数不出来：所以界面一定先数再退出
    expect(await defaultExitDeps.pendingCount()).toBeNull();
  });

  it('清库一直卡住、改按库名删库：先关本页连接再删，本页不 reload；signOut 照常做完，最后删本机会话', async () => {
    const idb = withDeleteDatabase(fakeIndexedDB().factory);
    vi.stubGlobal('indexedDB', idb.factory);
    const reload = vi.fn();
    const b = await boot(idb.factory, reload);
    const { cache } = b;
    if (!cache) throw new Error('boot');
    vi.spyOn(cache, 'clearAll').mockImplementation(() => new Promise<void>(() => undefined));
    const log: string[] = [];
    const r = await signOutThisDevice({
      server: { signOut: async () => (log.push('signout'), { serverDone: false }) },
      steps: { ...defaultExitDeps, clearCacheStorage: async () => void log.push('caches'), clearLocalSessionIf: () => void log.push('session') },
      readUserId: () => 'A',
      wipeMs: 50,
    });
    expect(r).toEqual({ serverDone: false });
    // 清库卡住改按库名删一次；会话删掉以后再删一次（⑤）
    expect(idb.deleted).toEqual(['planner-v4', 'planner-v4']);
    expect(log).toEqual(['caches', 'signout', 'session']);
    expect(reload).not.toHaveBeenCalled();
    // 退出期间一直占着“忙”，别的标签页要升级也不 reload（最后由 goToAuth 离开页面）
    expect(b.upgrade.getState().busy).toBe(true);
  });

  it('clearAll 卡住时 close 要等进行中的事务做完才真关：按库名删库两次都 blocked，后续步骤照样做完、不 reload', async () => {
    const idb = withDeleteDatabase(fakeIndexedDB().factory);
    vi.stubGlobal('indexedDB', idb.factory);
    const reload = vi.fn();
    const b = await boot(idb.factory, reload);
    const { cache } = b;
    if (!cache) throw new Error('boot');
    vi.spyOn(cache, 'clearAll').mockImplementation(() => new Promise<void>(() => undefined));
    // 浏览器的语义：close() 只是“请求关闭”，进行中的事务（卡住的 clearAll）做完以前连接还开着
    for (const c of idb.conns()) c.close = () => undefined;
    // 两次删库都 blocked，各要等满 DELETE_WAIT_MS：用假时钟拨过去，不真等 6 秒（boot 用真时钟做完再切）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log: string[] = [];
    let r: { serverDone: boolean } | undefined;
    const running = signOutThisDevice({
      server: { signOut: async () => (log.push('signout'), { serverDone: true }) },
      steps: { ...defaultExitDeps, clearCacheStorage: async () => void log.push('caches'), clearLocalSessionIf: () => void log.push('session') },
      readUserId: () => 'A',
      wipeMs: 50,
    }).then((v) => (r = v));
    // 第一次删库还在等：没到 DELETE_WAIT_MS 不算完
    await vi.advanceTimersByTimeAsync(50 + DELETE_WAIT_MS - 1);
    expect(r).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DELETE_WAIT_MS + 1);
    await running;
    expect(r).toEqual({ serverDone: true });
    expect(idb.deleted).toEqual([]);
    expect(log).toEqual(['caches', 'signout']);
    expect(reload).not.toHaveBeenCalled();
  });
});
