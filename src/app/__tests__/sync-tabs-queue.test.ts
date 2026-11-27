// 非主页改了队列、待发数却没变时也要提醒主页（OUTBOX-cross-tab）：合并进已排队的项、清退避、同一轮多次只提醒一次；
// 主页收到提醒先 refresh 再 sendNow，和引擎自己订阅 outbox 触发的发送不叠成两次。
// 真实的多标签页是两份 outbox 开在同一个本机库上（sync-tabs.test.ts 的两页共用一个 boot，测不到这种缺口）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { outboxCtx, type OutboxItem } from '../../core/outbox.ts';
import { OUTBOX } from '../../core/cache-schema.ts';
import { clearAllCollections } from '../../core/store.ts';
import { createSync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport, FakeServer, type FakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { createTabLeader, type ChannelLike, type LocksLike, type TabLeaderOptions } from '../../platform/tab-leader.ts';
import { fakeBus, fakeLocks, fakeVisibility } from '../../platform/__tests__/tab-fakes.ts';
import { wireSync } from '../sync-wiring.ts';

type Factory = ReturnType<typeof fakeIndexedDB>['factory'];

function bootOpts(factory: Factory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: () => undefined, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 测试里拿 boot 的 cache、outbox：没有就抛（代替非空断言） */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('缺少对象');
  return v;
}

const boots: BootResult[] = [];
async function openBoot(factory: Factory): Promise<BootResult> {
  const b = await coldStart(bootOpts(factory));
  boots.push(b);
  return b;
}

function deps(t: FakeTransport) {
  return {
    transport: t,
    clearCacheStorage: () => Promise.resolve(),
    clearLocalSessionIf: () => Promise.resolve(true),
    goToAuth: () => undefined,
    setExitNotice: () => undefined,
    create: (b: BootResult, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: fakeLife(true) }),
    lifecycle: fakeLife(true),
  };
}

/** 永远不是主页的一页：发出去的提醒记在 posts 里 */
function follower(boot: BootResult, posts: unknown[]) {
  return wireSync(boot, {
    ...deps(fakeTransport(new FakeServer())),
    leader: () => ({ isLeader: () => false, post: (m) => void posts.push(m), close: () => Promise.resolve() }),
  });
}

/** 真的一页：自己的 boot（自己的 outbox），同一个本机库、同一组锁和频道 */
function page(boot: BootResult, locks: LocksLike, bus: (n: string) => ChannelLike, server: FakeServer) {
  const t = fakeTransport(server);
  const sync = wireSync(boot, {
    ...deps(t),
    leader: (o: TabLeaderOptions) => createTabLeader({ ...o, locks, channel: bus, visibility: fakeVisibility(true) }),
    onActivity: () => () => undefined,
  });
  return { sync, t };
}

const sends = (t: FakeTransport, n: number): string[] => t.calls.filter((c) => c.endsWith(`:todos:${uid(n)}`));

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  for (const b of boots.splice(0)) b.cache?.close();
  resetBootForTest();
});

describe('非主页改了队列就提醒主页（OUTBOX-cross-tab）', () => {
  it('合并进已排队的 patch（待发数不变）也提醒一次', async () => {
    const boot = await openBoot(fakeIndexedDB().factory);
    const posts: unknown[] = [];
    const sync = follower(boot, posts);
    await flush();
    const ob = must(boot.outbox);
    await ob.enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });
    await ob.enqueue({ table: 'todos', id: uid(7), op: 'patch', data: { title: '一' } });
    await flush();
    expect(ob.getStatus().pending).toBe(2);
    posts.length = 0;
    await ob.enqueue({ table: 'todos', id: uid(7), op: 'patch', data: { title: '二' } });   // 并进上一个 patch
    await flush();
    expect(ob.getStatus().pending).toBe(2);
    expect(posts).toEqual([{ type: 'outbox' }]);
    await sync?.stop();
  });

  it('清退避（只改 next_at）也提醒一次', async () => {
    const boot = await openBoot(fakeIndexedDB().factory);
    const posts: unknown[] = [];
    const sync = follower(boot, posts);
    await flush();
    const ob = must(boot.outbox);
    await ob.enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });
    await must(boot.cache).tx([OUTBOX], 'readwrite', async (t) => {
      for (const i of await t.getAll<OutboxItem>(OUTBOX)) await t.put(OUTBOX, { ...i, sent: true, tries: 1, next_at: Date.now() + 60_000 });
    });
    await flush();
    posts.length = 0;
    await ob.clearBackoff();
    await flush();
    expect(posts).toEqual([{ type: 'outbox' }]);
    await sync?.stop();
  });

  it('同一轮里队列变了好几次：只提醒一次', async () => {
    const boot = await openBoot(fakeIndexedDB().factory);
    const posts: unknown[] = [];
    const sync = follower(boot, posts);
    await flush();
    const ob = must(boot.outbox);
    await ob.enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });
    await flush();
    posts.length = 0;
    const ctx = must(outboxCtx.get(ob));
    ctx.emit({ type: 'queue' });
    ctx.emit({ type: 'queue' });
    ctx.emit({ type: 'queue' });
    await flush();
    expect(posts).toEqual([{ type: 'outbox' }]);
    await sync?.stop();
  });
});

describe('两页各有自己的 outbox（同一个本机库）', () => {
  it('非主页清退避后，主页不等退避到点就发出去；同一项只发一次', async () => {
    const { factory } = fakeIndexedDB();
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const bootA = await openBoot(factory);
    const a = page(bootA, locks, bus, server);
    await flush();
    await a.sync?.idle();
    const bootB = await openBoot(factory);
    const b = page(bootB, locks, bus, server);
    await flush();
    a.t.offline = true;   // 主页这时发不出去（会话检查就断网，不动队列）
    await must(bootB.outbox).enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });
    await flush(10);
    await a.sync?.idle();
    // 当作发过一次、断网失败，进了退避（1 分钟）
    await must(bootB.cache).tx([OUTBOX], 'readwrite', async (t) => {
      for (const i of await t.getAll<OutboxItem>(OUTBOX)) await t.put(OUTBOX, { ...i, sent: true, tries: 1, next_at: Date.now() + 60_000 });
    });
    a.t.offline = false;
    a.t.calls.length = 0;
    await must(bootB.outbox).clearBackoff();   // 比如 B 页回到在线
    await vi.waitFor(() => expect(server.table('todos').has(uid(7))).toBe(true), { timeout: 1000 });
    await a.sync?.idle();
    await flush(10);
    expect(sends(a.t, 7)).toEqual([`insert:todos:${uid(7)}`]);
    expect(b.t.calls).toEqual([]);
    await b.sync?.stop();
    await a.sync?.stop();
  });

  it('非主页的新写入：主页 refresh 后引擎自己触发的发送和 sendNow 不叠成两次', async () => {
    const { factory } = fakeIndexedDB();
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const bootA = await openBoot(factory);
    const a = page(bootA, locks, bus, server);
    await flush();
    await a.sync?.idle();
    const bootB = await openBoot(factory);
    const b = page(bootB, locks, bus, server);
    await flush();
    const refresh = vi.spyOn(must(bootA.outbox), 'refresh');
    const next = vi.spyOn(must(bootA.outbox), 'next');
    await must(bootB.outbox).enqueue({ table: 'todos', id: uid(8), op: 'insert', data: todo(8) });
    await vi.waitFor(() => expect(server.table('todos').has(uid(8))).toBe(true), { timeout: 1000 });
    await a.sync?.idle();
    await flush(10);
    expect(refresh).toHaveBeenCalled();
    // 一轮发送取两次（取到这一项、取空）+ 确认后摘要变了引擎再 kick 一轮取空 = 3；refresh 触发的和 sendNow 叠成两轮会是 4（去掉 sendQueued 实测）
    expect(next.mock.calls.length).toBeLessThanOrEqual(3);
    expect(sends(a.t, 8)).toEqual([`insert:todos:${uid(8)}`]);
    expect(must(bootA.outbox).getStatus().pending).toBe(0);   // 主页的待发数也跟上了
    expect(b.t.calls).toEqual([]);
    await b.sync?.stop();
    await a.sync?.stop();
  });

  it('非主页合并进已排队的项（待发数不变）：主页马上发出合并后的内容，只发一次', async () => {
    const { factory } = fakeIndexedDB();
    const server = new FakeServer();
    const row = server.insert('todos', todo(9));
    const locks = fakeLocks();
    const bus = fakeBus();
    const bootA = await openBoot(factory);
    await must(bootA.cache).putRows('todos', [{ id: uid(9), server: row as never, view: row as never }]);   // 本机已同步过这一行
    const a = page(bootA, locks, bus, server);
    await flush();
    await a.sync?.idle();
    const bootB = await openBoot(factory);
    const b = page(bootB, locks, bus, server);
    await flush(10);
    a.t.offline = true;   // 会话检查就断网：这一项不动、没发过（还能合并），也不排退避计时
    await must(bootB.outbox).enqueue({ table: 'todos', id: uid(9), op: 'patch', data: { title: '一' } });
    await flush(10);
    await a.sync?.idle();
    a.t.offline = false;
    a.t.calls.length = 0;
    await must(bootB.outbox).enqueue({ table: 'todos', id: uid(9), op: 'patch', data: { title: '二' } });   // 并进上一项
    expect(must(bootB.outbox).getStatus().pending).toBe(1);
    await vi.waitFor(() => expect(server.table('todos').get(uid(9))?.['title']).toBe('二'), { timeout: 1000 });
    await a.sync?.idle();
    await flush(10);
    expect(sends(a.t, 9)).toEqual([`patch:todos:${uid(9)}`]);
    expect(b.t.calls).toEqual([]);
    await b.sync?.stop();
    await a.sync?.stop();
  });
});
