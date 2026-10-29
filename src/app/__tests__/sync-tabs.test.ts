// 多标签页只让主页跑同步（架构 4.3b、0.38 第 58 条）的接线：两个页面只有一个发请求；主页关闭后另一页 1 秒内接手并补拉；
// 主页隐藏后前台页接手；非主页写入由主页发出；report_tz 只在主页报（启动 report(true)、用户操作 report()、重新拿到锁再 report(true)）。
// “整表重拉期间另一页的写入不丢、本机行不被误删”（审查员的复现用例）在 core/sync/__tests__/paging.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { clearAllCollections } from '../../core/store.ts';
import { createSync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport, FakeServer, type FakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { createTabLeader, type ChannelLike, type LocksLike, type TabLeaderOptions } from '../../platform/tab-leader.ts';
import { fakeBus, fakeLocks, fakeVisibility } from '../../platform/__tests__/tab-fakes.ts';
import { wireSync } from '../sync-wiring.ts';

function bootOpts(): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory: fakeIndexedDB().factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: () => undefined, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 一个“页面”：同一个本机库（同一个 boot），自己的传输、可见性、用户操作 */
function page(boot: Awaited<ReturnType<typeof coldStart>>, locks: LocksLike, bus: (n: string) => ChannelLike, server: FakeServer, visible = true) {
  const vis = fakeVisibility(visible);
  const t: FakeTransport = fakeTransport(server);
  const tz: string[] = [];
  t.reportTz = (zone) => {
    tz.push(zone);
    return Promise.resolve({ ok: true, value: 'unchanged' });
  };
  let activity: (() => void) | null = null;
  const sync = wireSync(boot, {
    transport: t,
    clearCacheStorage: () => Promise.resolve(),
    takeLocalSession: () => null, clearLocalSessionIf: () => undefined,
    goToAuth: () => undefined,
    setExitNotice: () => undefined,
    deviceId: () => 'dev-1',
    create: (b, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: fakeLife(visible) }),
    leader: (o: TabLeaderOptions) => createTabLeader({ ...o, locks, channel: bus, visibility: vis }),
    lifecycle: fakeLife(visible),
    onActivity: (fn) => {
      activity = fn;
      return () => {
        activity = null;
      };
    },
  });
  return { sync, t, vis, tz, act: () => activity?.() };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('只让主页跑同步（4.3b）', () => {
  it('两个页面只有一个发请求；主页关闭后另一页 1 秒内接手并补拉', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    server.insert('todos', todo(1));
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(boot, locks, bus, server);
    const b = page(boot, locks, bus, server);
    await flush();
    await a.sync?.idle();
    expect(a.t.calls).toContain('pull:todos');
    expect(b.t.calls).toEqual([]);

    const t0 = Date.now();
    await a.sync?.stop();
    await vi.waitFor(() => expect(b.t.calls).toContain('pull:todos'), { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    b.sync?.stop();
  });

  it('主页隐藏后前台页接手', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(boot, locks, bus, server);
    const b = page(boot, locks, bus, server, false);
    await flush();
    b.vis.set(true);
    a.vis.set(false);
    await vi.waitFor(() => expect(b.t.calls).toContain('pull:todos'), { timeout: 1000 });
    a.t.calls.length = 0;
    await flush();
    expect(a.t.calls).toEqual([]);
    b.sync?.stop();
    a.sync?.stop();
  });

  it('非主页写入由主页发出', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(boot, locks, bus, server);
    const b = page(boot, locks, bus, server);
    await flush();
    await a.sync?.idle();
    await boot.outbox?.enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });   // 在 b 页写入（同一个本机库）
    await vi.waitFor(() => expect(server.table('todos').has(uid(7))).toBe(true), { timeout: 1000 });
    expect(a.t.calls).toContain(`insert:todos:${uid(7)}`);
    expect(b.t.calls).toEqual([]);
    a.sync?.stop();
    b.sync?.stop();
  });

  it('report_tz 只在主页报：拿到锁 report(true)；用户操作 report()（5 分钟内跳过）；重新拿到锁再 report(true)', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(boot, locks, bus, server);
    const b = page(boot, locks, bus, server);
    await flush();
    expect(a.tz).toHaveLength(1);
    expect(b.tz).toHaveLength(0);
    a.act();
    await flush();
    expect(a.tz).toHaveLength(1);   // 不到 5 分钟：跳过
    b.act();
    expect(b.tz).toHaveLength(0);   // 非主页没挂监听
    a.vis.set(false);
    await vi.waitFor(() => expect(b.tz).toHaveLength(1), { timeout: 1000 });
    b.vis.set(false);
    a.vis.set(true);
    await vi.waitFor(() => expect(a.tz).toHaveLength(2), { timeout: 1000 });   // 重新拿到锁：report(true)
    a.sync?.stop();
    b.sync?.stop();
  });
});
