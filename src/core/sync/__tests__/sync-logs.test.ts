// 同步层的日志（接手清单 K8-logs；架构 0.38 第 67 条、数据字典 4.6“同步与设备登记日志的写法”）：
// sync_conflict（code = conflict / forked）、sync_gone（code = gone）、outbox_rejected（code = 拒收码，patch_bad_args 不重复记）；
// 只填 coll、code，不放内容、记录 id、op_id、冲突双方的版本
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../boot.ts';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { fakeIndexedDB } from '../../__tests__/idb-fake.ts';
import { clearAllCollections } from '../../store.ts';
import { createSync } from '../engine.ts';
import { sendAll } from '../send.ts';
import type { SyncLog } from '../types.ts';
import { fakeLife, fakeTransport, identityParse } from './fake-server.ts';

type Entry = [string, Parameters<SyncLog>[1]];
const recorder = (): { log: SyncLog; entries: Entry[] } => {
  const entries: Entry[] = [];
  return { entries, log: (act, f) => entries.push([act, f]) };
};

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('send.ts：sync_conflict、sync_gone', () => {
  async function prepared() {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = uid(1);
    const row = t.server.insert('todos', todo(1));
    await seed(cache, 'todos', id, todo(1), row.rev);
    const r = recorder();
    const deps = {
      outbox, transport: t, gated: () => outbox.isSuspended(), blocked: () => false,
      emit: () => undefined, removed: () => undefined, touched: () => undefined, log: r.log,
    };
    return { outbox, t, id, r, deps };
  }

  it('conflict：记一条 sync_conflict，coll = 表名、code = conflict，别的都不带', async () => {
    const p = await prepared();
    p.t.server.edit('todos', p.id, { title: '另一台' });
    await p.outbox.enqueue({ table: 'todos', id: p.id, op: 'patch', data: { title: '本机' } });
    await sendAll(p.deps);
    expect(p.r.entries).toEqual([['sync_conflict', { coll: 'todos', code: 'conflict' }]]);
  });

  it('forked：code = forked（不另立 act）', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = uid(2);
    const row = t.server.insert('notes', { id, title: '原', body: '正文', tags: [] });
    await seed(cache, 'notes', id, { id, title: '原', body: '正文', tags: [] }, row.rev);
    t.server.edit('notes', id, { title: '另一台' });
    await outbox.enqueue({ table: 'notes', id, op: 'patch', data: { title: '本机' } });
    const r = recorder();
    await sendAll({ outbox, transport: t, gated: () => false, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined, log: r.log });
    expect(r.entries).toEqual([['sync_conflict', { coll: 'notes', code: 'forked' }]]);
  });

  it('gone：记一条 sync_gone，coll = 表名、code = gone；不带修改内容、op_id、记录 id', async () => {
    const p = await prepared();
    p.t.server.edit('todos', p.id, { deleted_at: 123 });
    await p.outbox.enqueue({ table: 'todos', id: p.id, op: 'patch', data: { title: '我的修改' } });
    await sendAll(p.deps);
    expect(p.r.entries).toEqual([['sync_gone', { coll: 'todos', code: 'gone' }]]);
    expect(JSON.stringify(p.r.entries)).not.toContain('我的修改');
  });

  it('ok：不记', async () => {
    const p = await prepared();
    await p.outbox.enqueue({ table: 'todos', id: p.id, op: 'patch', data: { title: '本机' } });
    await sendAll(p.deps);
    expect(p.r.entries).toEqual([]);
  });
});

describe('engine.ts：outbox_rejected', () => {
  async function engine() {
    const boot = await coldStart({
      userId: 'A', appVersion: '4.0.0', cacheOptions: { factory: fakeIndexedDB().factory }, listen426: false,
      clearCacheStorage: () => Promise.resolve(),
      upgradeDeps: { reload: () => undefined, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    });
    const t = fakeTransport();
    const r = recorder();
    const sync = createSync(boot, { transport: t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined, log: r.log });
    sync.start();
    await sync.idle();
    return { boot, t, r, sync };
  }

  it('服务器拒收（vault_required）：记 outbox_rejected，coll = 表名、code = 拒收码', async () => {
    const e = await engine();
    e.t.failNext.push({ status: 400, code: 'vault_required' });
    await e.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await e.sync.idle();
    expect(e.r.entries.filter(([a]) => a === 'outbox_rejected')).toEqual([['outbox_rejected', { coll: 'todos', code: 'vault_required' }]]);
    e.sync.stop();
  });

  it('patch_bad_args：只记 send.ts 的 sync_patch_bad_args（带 sqlstate），不再记 outbox_rejected', async () => {
    const e = await engine();
    const id = uid(2);
    e.t.server.insert('todos', todo(2));
    await e.sync.syncNow();
    e.t.failNext.push({ status: 400, code: 'patch_bad_args', detail: '22P02' });
    await e.boot.outbox?.enqueue({ table: 'todos', id, op: 'patch', data: { title: 'x' } });
    await e.sync.idle();
    const acts = e.r.entries.map(([a]) => a);
    expect(acts).toContain('sync_patch_bad_args');
    expect(acts).not.toContain('outbox_rejected');
    e.sync.stop();
  });
});
