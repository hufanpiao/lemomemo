// K8 同步引擎：cache === null 安全降级（接手清单 K6-ver-new）、启动先发后拉、两台设备同时改同一条（TC-B1-23）、
// Realtime 只订阅同步表和墓碑、连上补拉、断了轮询（TC-B1-28 的本机部分）、前后台、上线、闸和 CacheClosedError、被移除只处理一次、
// 整表重拉完成后写 schema_v
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../boot.ts';
import { CacheClosedError, type Cache } from '../../cache.ts';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import type { Outbox } from '../../outbox-types.ts';
import { clearAllCollections } from '../../store.ts';
import { createUpgradeCenter } from '../../upgrade.ts';
import type { Lifecycle } from '../../../platform/net.ts';
import { createSync, type Sync, type SyncOptions } from '../engine.ts';
import { POLL_INTERVAL_MS } from '../realtime-link.ts';
import { createRunner } from '../runner.ts';
import type { SyncEvent } from '../types.ts';
import { FakeServer, fakeTransport, identityParse } from './fake-server.ts';

function bootOf(cache: Cache | null, outbox: Outbox | null, over: Partial<BootResult> = {}): BootResult {
  return {
    status: cache ? 'ready' : 'unavailable',
    userId: uid(100),
    switching: false,
    cache,
    outbox,
    upgrade: createUpgradeCenter({ appVersion: '4.0.0', reload: () => undefined, swUpdate: () => Promise.resolve('none' as never), attempt: { get: () => null, set: () => undefined } }),
    config: null,
    profile: null,
    flags: null,
    fullResync: [],
    refetch: {},
    switchedUser: false,
    purged: 0,
    upgradeReport: null,
    outboxReport: null,
    error: null,
    ...over,
  };
}

function fakeLife(visible = true): Lifecycle & { goOnline(): void; setVisible(v: boolean): void } {
  const online = new Set<() => void>();
  const vis = new Set<(v: boolean) => void>();
  let isVis = visible;
  const add = <T>(s: Set<T>, f: T): (() => void) => {
    s.add(f);
    return () => {
      s.delete(f);
    };
  };
  return {
    onOnline: (f) => add(online, f),
    onVisibility: (f) => add(vis, f),
    isVisible: () => isVis,
    isOnline: () => true,
    goOnline: () => online.forEach((f) => f()),
    setVisible(v) {
      isVis = v;
      vis.forEach((f) => f(v));
    },
  };
}

const running: Sync[] = [];
async function device(server = new FakeServer(), over: Partial<SyncOptions> = {}, bootOver: Partial<BootResult> = {}) {
  const { cache, outbox } = await setup();
  const t = fakeTransport(server);
  const life = fakeLife();
  const removed: string[] = [];
  const events: SyncEvent[] = [];
  const boot = bootOf(cache, outbox, bootOver);
  const sync = createSync(boot, { transport: t, parseRows: identityParse, lifecycle: life, now: () => clock.t, skipConfig: true, onRemoved: (c) => removed.push(c), ...over });
  sync.onEvent((e) => events.push(e));
  running.push(sync);
  return { cache, outbox, t, life, sync, boot, removed, events };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
  vi.useRealTimers();
});

describe('cache === null 安全降级（K6-ver-new）', () => {
  it('本机库打不开、version_too_new：start、syncNow、sendNow 什么也不做、不抛；状态是 stopped', async () => {
    const t = fakeTransport();
    for (const status of ['unavailable', 'version_too_new', 'signed_out'] as const) {
      const sync = createSync(bootOf(null, null, { status }), { transport: t, onRemoved: () => undefined });
      expect(() => sync.start()).not.toThrow();
      await expect(sync.syncNow()).resolves.toBeUndefined();
      await expect(sync.sendNow()).resolves.toBeUndefined();
      expect(sync.getState().stopped).toBe(true);
    }
    expect(t.calls).toEqual([]);
  });
});

describe('启动', () => {
  it('先发后拉；Realtime 订阅 9 张同步表；整表重拉完成后写 schema_v', async () => {
    const server = new FakeServer();
    server.insert('todos', todo(2));
    const d = await device(server, { schemaV: 7 }, { fullResync: ['todos'] });
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    d.sync.start();
    await d.sync.idle();
    expect(d.t.calls[0]).toBe(`insert:todos:${uid(1)}`);
    expect(d.t.calls).toContain('pull:todos');
    expect(d.t.calls).toContain('tombstones');
    expect(await d.cache.getRow('todos', uid(2))).toBeDefined();
    expect(d.t.subscribedTables).toEqual(d.cache.syncTables);
    expect(d.t.subscribedTables).toHaveLength(9);
    expect(await d.cache.getMeta('schema_v')).toBe(7);
    expect(d.sync.getState()).toMatchObject({ stopped: false, syncing: false, lastPullAt: clock.t });
  });

  it('入队后马上发（outbox 状态变了就踢一下发送）', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    await d.outbox.enqueue({ table: 'todos', id: uid(3), op: 'insert', data: todo(3) });
    await d.sync.idle();
    expect(d.t.server.table('todos').has(uid(3))).toBe(true);
  });
});

describe('TC-B1-23 两台设备同时改同一条的同一字段', () => {
  it('后到的一边收到 conflict 事件（带对方的旧值）；之后两边都是后保存的值', async () => {
    const server = new FakeServer();
    server.insert('todos', todo(1));
    const a = await device(server);
    const b = await device(server);
    a.sync.start();
    b.sync.start();
    await a.sync.idle();
    await b.sync.idle();

    await a.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'A 改的' } });
    await b.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'B 改的' } });
    await a.sync.idle();
    await b.sync.idle();
    expect(a.events).toEqual([]);
    expect(b.events).toHaveLength(1);
    expect(b.events[0]).toMatchObject({ type: 'conflict', status: 'conflict', conflicts: ['title'], old: { title: 'A 改的' } });

    await a.sync.syncNow();
    expect((await a.cache.getRow('todos', uid(1)))?.view).toMatchObject({ title: 'B 改的' });
    expect((await b.cache.getRow('todos', uid(1)))?.view).toMatchObject({ title: 'B 改的' });
  });
});

describe('Realtime、轮询、前后台、上线', () => {
  it('Realtime 的行合并进本机；第一次连上和启动那一轮合并、断了再连上补拉一次；断了每 60 秒轮询', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    const row = d.t.server.insert('todos', todo(5));
    d.t.handlers?.onRow('todos', { ...row });
    await d.sync.idle();
    expect(await d.cache.getRow('todos', uid(5))).toBeDefined();

    d.t.calls.length = 0;
    d.t.handlers?.onStatus('up');   // 这次连接第一次连上：启动那一轮已经在连接以后开始过，不再整轮补拉（K8 审查建议）
    await d.sync.idle();
    expect(d.sync.getState().realtime).toBe('up');
    expect(d.t.calls.filter((c) => c.startsWith('pull:'))).toEqual([]);

    d.t.handlers?.onStatus('down');
    d.t.handlers?.onStatus('up');   // 断了再连上：补拉断开期间的改动
    await d.sync.idle();
    expect(d.t.calls).toContain('pull:todos');

    d.t.calls.length = 0;
    vi.advanceTimersByTime(POLL_INTERVAL_MS);   // 连着：不轮询
    await d.sync.idle();
    expect(d.t.calls.filter((c) => c.startsWith('pull:'))).toEqual([]);

    d.t.handlers?.onStatus('down');
    vi.advanceTimersByTime(POLL_INTERVAL_MS);   // 断了：轮询兜底
    await d.sync.idle();
    expect(d.t.calls).toContain('pull:todos');
  });

  it('Realtime 的墓碑删本机行', async () => {
    const d = await device();
    d.t.server.insert('todos', todo(6));
    d.sync.start();
    await d.sync.idle();
    d.t.handlers?.onTombstone({ tbl: 'todos', id: uid(6), deleted_at: '2026-10-29T01:00:00Z' });
    await d.sync.idle();
    expect(await d.cache.getRow('todos', uid(6))).toBeUndefined();
  });

  it('切到后台断开 Realtime；回到前台重连、清退避、先发后拉', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.life.setVisible(false);
    expect(d.t.unsubscribed).toBe(1);
    expect(d.t.handlers).toBeNull();

    d.t.offline = true;
    await d.outbox.enqueue({ table: 'todos', id: uid(7), op: 'insert', data: todo(7) });
    await d.sync.idle();
    expect((await d.outbox.list())[0]?.next_at).toBe(0);   // ensureSession 断网：没发，也没退避

    d.t.offline = false;
    d.life.setVisible(true);
    await d.sync.idle();
    expect(d.t.handlers).not.toBeNull();
    expect(d.t.server.table('todos').has(uid(7))).toBe(true);
  });

  it('上线：清掉退避马上发', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.t.failNext.push({ network: true });
    await d.outbox.enqueue({ table: 'todos', id: uid(8), op: 'insert', data: todo(8) });
    await d.sync.idle();
    expect((await d.outbox.list())[0]?.next_at).toBeGreaterThan(clock.t);
    d.life.goOnline();
    await d.sync.idle();
    expect(await d.outbox.list()).toEqual([]);
  });
});

describe('闸、CacheClosedError、被移除', () => {
  it('换账号（boot.switching）：下一个时机就停下，断开 Realtime、不再发', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.boot.switching = true;
    d.outbox.suspend();
    await d.sync.syncNow();
    expect(d.sync.getState().stopped).toBe(true);
    expect(d.t.handlers).toBeNull();
  });

  it('库被封存（seal）：停下，不报错、不记日志', async () => {
    const log = vi.fn();
    const d = await device(new FakeServer(), { log });
    d.sync.start();
    await d.sync.idle();
    d.cache.seal();
    await d.outbox.enqueue({ table: 'todos', id: uid(9), op: 'insert', data: todo(9) }).catch(() => undefined);
    await d.sync.syncNow();
    expect(d.sync.getState().stopped).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('串行链里的活抛 CacheClosedError：当作停下，不记日志；别的错只记错误码、链接着走', async () => {
    const halt = vi.fn();
    const log = vi.fn();
    const r = createRunner(() => false, halt, log);
    await r.run(() => Promise.reject(new CacheClosedError()));
    expect(halt).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    await r.run(() => Promise.reject(new Error('boom')));
    expect(log).toHaveBeenCalledWith('sync_error');
    let ran = false;
    await r.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('刷新令牌发现被移除：onRemoved 只调一次，同步停下', async () => {
    const d = await device();
    d.t.ensure = 'removed';
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    d.sync.start();
    await d.sync.idle();
    await d.sync.syncNow();
    expect(d.removed).toEqual(['session_not_found']);
    expect(d.sync.getState().stopped).toBe(true);
  });

  it('outbox 的 removed 事件（服务器回 session_revoked）：同步停下，清本机交给 main.tsx', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.t.failNext.push({ status: 400, code: 'account_disabled' });
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await d.sync.idle();
    expect(d.sync.getState().stopped).toBe(true);
    expect(d.removed).toEqual([]);
  });

  it('服务器拒收（rejected）：整表重拉那张表', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.t.calls.length = 0;
    d.t.failNext.push({ status: 400, code: 'vault_required' });
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await d.sync.idle();
    expect(d.t.calls).toContain('pull:todos');
    expect(await d.outbox.list()).toEqual([]);
  });
});
