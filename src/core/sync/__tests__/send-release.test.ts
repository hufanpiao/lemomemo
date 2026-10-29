// 发出去过的项（sent）不再合并新修改、不再和撤销抵消（K8 三审必改②，探针 P7）；分批发送（一批 20 项或 15 秒，K8 复审建议 1）；
// patch_bad_args 丢项时记服务器原报错（K1 审查）。从 link-drain.test.ts 拆出（行数上限）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { createSync, type Sync } from '../engine.ts';
import { sendAll } from '../send.ts';
import { bootOf, fakeLife, fakeTransport, FakeServer, identityParse } from './fake-server.ts';

const running: Sync[] = [];
async function device() {
  const { cache, outbox } = await setup();
  const t = fakeTransport(new FakeServer());
  const sync = createSync(bootOf(cache, outbox), {
    transport: t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined,
  });
  running.push(sync);
  return { cache, outbox, t, sync };
}
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

describe('发出去过的项不再合并新修改（K8 三审必改②，探针 P7）', () => {
  async function patched() {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const row = t.server.insert('todos', todo(1));
    await seed(cache, 'todos', uid(1), todo(1), row.rev);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    return { cache, outbox, t };
  }
  const deps = (outbox: Awaited<ReturnType<typeof setup>>['outbox'], t: ReturnType<typeof fakeTransport>, gated: () => boolean) => ({
    outbox, transport: t, gated, released: gated, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
  });

  it('K8R-7 patch 已上服务器、回包时正在放手，用户又改了一次：服务器最后是新值', async () => {
    const { cache, outbox, t } = await patched();
    let released = false;
    const orig = t.applyPatch.bind(t);
    t.applyPatch = async (a) => {
      const r = await orig(a);
      released = true;   // 服务器已应用，回包时本页正在放手
      return r;
    };
    expect(await sendAll(deps(outbox, t, () => released))).toBe('stopped');
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'y' } });
    t.applyPatch = orig;
    expect(await sendAll(deps(outbox, t, () => false))).toBe('done');
    expect(t.server.table('todos').get(uid(1))?.['title']).toBe('y');
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('y');
    expect(await outbox.list()).toEqual([]);
  });

  it('K8R-8 回包没拿到（复位成 pending）后用户又改：另开新 op_id，服务器最后是新值', async () => {
    const { outbox, t } = await patched();
    const first = (await outbox.list())[0];
    await outbox.next();   // 发出去了
    await outbox.resetInflight();   // 没拿到回包（新主页 start 复位）
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'y' } });
    const items = await outbox.list();
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ op_id: first?.op_id, data: { title: 'x' }, sent: true });
    expect(items[1]?.op_id).not.toBe(first?.op_id);
    expect(await sendAll(deps(outbox, t, () => false))).toBe('done');
    expect(t.server.table('todos').get(uid(1))?.['title']).toBe('y');
  });

  it('K8R-9 boot() 复位的 inflight 也带 sent，不再合并（K6 遗留）', async () => {
    const { outbox } = await patched();
    await outbox.next();
    await outbox.boot();   // 重新载入
    expect((await outbox.list())[0]).toMatchObject({ state: 'pending', sent: true });
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'y' } });
    expect((await outbox.list()).length).toBe(2);
  });

  it('K8R-10 发出去过的 insert 不再和撤销抵消（服务器可能已有这一行）', async () => {
    const { outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.next();
    await outbox.resetInflight();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { undone: true } });
    expect((await outbox.list()).map((i) => i.op)).toEqual(['insert', 'patch']);
  });
});

describe('分批发送（K8 复审建议 1）', () => {
  it('K8R-4 一批最多 N 项：到了返回 more，剩下的留在 pending', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let i = 1; i <= 3; i++) await outbox.enqueue({ table: 'todos', id: uid(i), op: 'insert', data: todo(i) });
    const base = {
      outbox, transport: t, gated: () => false, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
    };
    expect(await sendAll({ ...base, batch: { items: 2, ms: 60_000 } })).toBe('more');
    expect((await outbox.list()).length).toBe(1);
    expect(await sendAll({ ...base, batch: { items: 2, ms: 60_000 } })).toBe('done');
    expect(await outbox.list()).toEqual([]);
  });

  it('K8R-5 一批最多 15 秒：时间到了返回 more', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let i = 1; i <= 3; i++) await outbox.enqueue({ table: 'todos', id: uid(i), op: 'insert', data: todo(i) });
    let now = 0;
    const orig = t.insertRow.bind(t);
    t.insertRow = async (table, data) => {
      now += 10_000;   // 每个请求花 10 秒
      return orig(table, data);
    };
    const out = await sendAll({
      outbox, transport: t, gated: () => false, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
      now: () => now,
    });
    expect(out).toBe('more');
    expect((await outbox.list()).length).toBe(1);   // 发了两项（10 秒、20 秒），第三项留到下一批
  });

  it('K8R-6 引擎收到 more 自动重新排队：25 项一次 sendNow 后全部发完', async () => {
    const d = await device();
    for (let i = 1; i <= 25; i++) await d.outbox.enqueue({ table: 'todos', id: uid(i), op: 'insert', data: todo(i) });
    d.sync.start();
    await vi.waitFor(async () => expect(await d.outbox.list()).toEqual([]));
    expect(d.t.calls.filter((c) => c.startsWith('insert:')).length).toBe(25);
  });
});

describe('patch_bad_args 丢项时记服务器原报错（K1 审查）', () => {
  it('记 sync_patch_bad_args：只记表名（coll）和 sqlstate（code），不记 sqlerrm（0.38 第 62 条）', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const row = t.server.insert('todos', todo(1));
    await seed(cache, 'todos', uid(1), todo(1), row.rev);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    t.failNext.push({ status: 400, code: 'patch_bad_args', detail: '23514' });
    const logs: [string, unknown][] = [];
    const out = await sendAll({
      outbox, transport: t, gated: () => false, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
      log: (c, f) => logs.push([c, f]),
    });
    expect(out).toBe('done');
    expect(logs).toEqual([['sync_patch_bad_args', { coll: 'todos', code: '23514' }]]);
    expect(await outbox.list()).toEqual([]);
  });
});
