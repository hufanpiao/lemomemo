// 多标签页只让主页跑同步（架构 4.3b、0.38 第 58 条）的接线：两个页面只有一个发请求；主页关闭后另一页 1 秒内接手并补拉；
// 主页隐藏后前台页接手；非主页写入由主页发出；report_tz 只在主页报（启动 report(true)、用户操作 report()、重新拿到锁再 report(true)）。
// “整表重拉期间另一页的写入不丢、本机行不被误删”（审查员的复现用例）在 core/sync/__tests__/paging.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { clearAllCollections, collection } from '../../core/store.ts';
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
    clearLocalSessionIf: () => Promise.resolve(true),
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

describe('同步暂停后只听（TABLEADER-listen，真选主、真频道）', () => {
  it('暂停页让出后另一页拿到锁，暂停页不再排队；暂停页收得到冷静期 reset，清库回登录页', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    const locks = fakeLocks();
    const bus = fakeBus();
    const vis = fakeVisibility(true);
    let onRemoved: SyncOptions['onRemoved'] = () => undefined;
    const goToAuth = vi.fn();
    const onSyncPaused = vi.fn();
    const made: TabLeaderOptions[] = [];
    const now = 1_000_000;
    const a = wireSync(boot, {
      transport: fakeTransport(server),
      clearCacheStorage: () => Promise.resolve(),
      clearLocalSessionIf: () => Promise.resolve(true),
      goToAuth,
      setExitNotice: () => undefined,
      create: (b, o: SyncOptions) => ((onRemoved = o.onRemoved), createSync(b, { ...o, skipConfig: true, lifecycle: fakeLife(true) })),
      // 和上面 page() 一样会盖掉 visibility：以前借 NEVER_VISIBLE 时只听的那个在这里会去抢锁
      leader: (o: TabLeaderOptions) => (made.push(o), createTabLeader({ ...o, locks, channel: bus, visibility: vis })),
      lifecycle: fakeLife(true),
      onActivity: () => () => undefined,
      probeAccount: () => Promise.resolve({ kind: 'active' as const }),
      readSession: () => ({ sid: 's1', token: 'tok-1' }),
      reload: vi.fn(),
      reloadMarks: () => ({ getItem: () => String(now - 1000), setItem: () => undefined }),
      now: () => now,
      onSyncPaused,
    });
    await flush();
    await a?.idle();
    // 另一个页面（普通选主，可见）：排在 a 后面
    let otherLeads = 0;
    const other = createTabLeader({
      name: 'lemo-sync:A',
      lead: () => (otherLeads++, () => Promise.resolve()),
      onMessage: () => undefined,
      locks,
      channel: bus,
      visibility: fakeVisibility(true),
    });
    await flush();
    expect(other.isLeader()).toBe(false);

    onRemoved('account_disabled', 's1');   // 5 分钟内第二次 active：限次触发、让出主页
    await vi.waitFor(() => expect(onSyncPaused).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(other.isLeader()).toBe(true), { timeout: 1000 });
    expect(otherLeads).toBe(1);
    expect(made.map((o) => o.listenOnly)).toEqual([undefined, true]);
    vis.set(false);
    vis.set(true);   // 暂停页回到前台：只听的不排队
    await flush();
    expect(other.isLeader()).toBe(true);

    other.post({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    await vi.waitFor(() => expect(goToAuth).toHaveBeenCalledTimes(1), { timeout: 1000 });
    await other.close();
    await flush();
    expect(locks.holder()).toBeNull();   // 另一页关了，暂停页（只听）也不接手
  });
});

describe('推迟启动期间漏掉的提醒（FA-6 推迟启动审查 M3）', () => {
  function wire(boot: Awaited<ReturnType<typeof coldStart>>, posts: unknown[], o: { isLeader?: boolean; onMake?: () => void } = {}) {
    return wireSync(boot, {
      transport: fakeTransport(new FakeServer()),
      clearCacheStorage: () => Promise.resolve(),
      clearLocalSessionIf: () => Promise.resolve(true),
      goToAuth: () => undefined,
      setExitNotice: () => undefined,
      create: (b, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: fakeLife(true) }),
      // 默认别的页是主页：本页永远拿不到锁。isLeader: true 时本页当主页（不调 lead，引擎不起，只看补读本身）
      leader: () => {
        o.onMake?.();
        return { isLeader: () => o.isLeader ?? false, post: (m) => void posts.push(m), close: () => Promise.resolve() };
      },
      lifecycle: fakeLife(true),
    });
  }

  it('频道一建好就整份重读一次：启动前别的页写进本机库的行这时出现在界面上；本页没有待发的不提醒主页', async () => {
    const boot = await coldStart(bootOpts());
    const row = todo(7);
    // 别的标签页（主页）在本页 wireSync 之前写了本机库，发的 changed 本页还没频道收
    await boot.cache?.putRows('todos', [{ id: row['id'] as string, server: row as never, view: row as never }]);
    expect(collection('todos').get(row['id'] as string)).toBeUndefined();
    const posts: unknown[] = [];
    const sync = wire(boot, posts);
    await vi.waitFor(() => expect(collection('todos').get(row['id'] as string)).toBeTruthy());
    await flush();
    expect(posts).toEqual([]);
    await sync?.stop();
  });

  it('本页启动前就有待发的写入（推迟期间写的）：读完以后提醒主页发一次', async () => {
    const boot = await coldStart(bootOpts());
    await boot.outbox?.enqueue({ table: 'todos', id: uid(8), op: 'insert', data: todo(8) });
    const posts: unknown[] = [];
    const sync = wire(boot, posts);
    await vi.waitFor(() => expect(posts).toEqual([{ type: 'outbox' }]));
    await sync?.stop();
  });

  it('本页是主页：读完以后有待发的也不给自己发 outbox 提醒（代码复审 N2）', async () => {
    const boot = await coldStart(bootOpts());
    await boot.outbox?.enqueue({ table: 'todos', id: uid(8), op: 'insert', data: todo(8) });
    const row = todo(7);
    await boot.cache?.putRows('todos', [{ id: row['id'] as string, server: row as never, view: row as never }]);
    const posts: unknown[] = [];
    const sync = wire(boot, posts, { isLeader: true });
    await vi.waitFor(() => expect(collection('todos').get(row['id'] as string)).toBeTruthy());
    await flush();
    expect(posts).toEqual([]);
    await sync?.stop();
  });

  for (const when of ['建频道时', 'wireSync 刚返回时'] as const) {
    it(`换账号闸在${when}设上：不补读，旧账号的行不灌回内存（代码复审 N2）`, async () => {
      const boot = await coldStart(bootOpts());
      const row = todo(7);
      await boot.cache?.putRows('todos', [{ id: row['id'] as string, server: row as never, view: row as never }]);
      const gate = (): void => {
        (boot as { switching: boolean }).switching = true;
      };
      if (!boot.cache) throw new Error('没有本机库');
      const allRows = vi.spyOn(boot.cache, 'allRows');
      if (!boot.outbox) throw new Error('没有 outbox');
      const refresh = vi.spyOn(boot.outbox, 'refresh');
      const sync = wire(boot, [], when === '建频道时' ? { onMake: gate } : {});
      if (when === 'wireSync 刚返回时') gate();
      await flush(10);
      expect(allRows).not.toHaveBeenCalled();
      // 建频道时就设上了：连 outbox 待发数也不重读（外层那道闸）；wireSync 返回以后才设：refresh 已经发出，回来再看闸（内层）
      if (when === '建频道时') expect(refresh).not.toHaveBeenCalled();
      expect(collection('todos').get(row['id'] as string)).toBeUndefined();
      (boot as { switching: boolean }).switching = false;
      await sync?.stop();
    });
  }
});
