// K8 拉取：增量（退 10 分钟、键集翻页、游标）、整表（25 天、本机有服务器没有的删掉、还没上服务器的不动）、
// 墓碑（TC-B1-59 本机部分：收到墓碑删本机行和队列项；缓存里没有的 id 忽略，L4）、待补拉（K7 的 updateRefetch / clearRefetch）、rebase
import { beforeEach, describe, expect, it } from 'vitest';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections, collection } from '../../store.ts';
import {
  applyRealtimeRow,
  applyRealtimeTombstone,
  FULL_RESYNC_AFTER_MS,
  lookback,
  PAGE_SIZE,
  pullTable,
  pullTombstones,
  refetchTable,
  type PullDeps,
} from '../pull.ts';
import type { ParseServerRows } from '../types.ts';
import { fakeTransport, identityParse, type FakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

async function make(parseRows: ParseServerRows = identityParse): Promise<{ d: PullDeps; t: FakeTransport }> {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  return { t, d: { cache, outbox, transport: t, parseRows, gated: () => false, now: () => clock.t } };
}

describe('增量拉取', () => {
  it('第一次整表拉；之后按游标退 10 分钟增量拉，游标记最大的 synced_at', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= 3; n++) t.server.insert('todos', todo(n));
    expect(await pullTable(d, 'todos')).toBe('ok');
    expect((await d.cache.allRows('todos')).length).toBe(3);
    const cur = await d.cache.getMeta('cursor:todos');
    expect(cur?.cursor).toBe(t.server.rows('todos')[2]?.synced_at);
    expect(cur?.fullSyncAt).toBe(clock.t);

    t.server.edit('todos', uid(2), { title: '别处改的' });
    const spy: { since: string | null }[] = [];
    const orig = t.pullRows.bind(t);
    t.pullRows = (table, q) => {
      spy.push({ since: q.since });
      return orig(table, q);
    };
    expect(await pullTable(d, 'todos')).toBe('ok');
    expect(spy[0]?.since).toBe(lookback(cur?.cursor ?? ''));
    expect((await d.cache.getRow('todos', uid(2)))?.view).toMatchObject({ title: '别处改的', rev: 2 });
    expect(collection<{ id: string; title?: string }>('todos').get(uid(2))?.title).toBe('别处改的');
  });

  it('一页放不下时按 (synced_at, id) 翻页，全部拉到', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= PAGE_SIZE + 5; n++) t.server.insert('todos', { id: uid(n), title: `t${n}` });
    expect(await pullTable(d, 'todos')).toBe('ok');
    expect((await d.cache.allRows('todos')).length).toBe(PAGE_SIZE + 5);
  });

  it('rebase：本机还没发的修改叠在服务器新值上，不被冲掉（4.3）', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    await pullTable(d, 'todos');
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '本机没发' } });
    t.server.edit('todos', uid(1), { note: '别处' });
    await pullTable(d, 'todos');
    expect((await d.cache.getRow('todos', uid(1)))?.view).toMatchObject({ title: '本机没发', note: '别处' });
  });

  it('断网：返回 net，游标不动', async () => {
    const { d, t } = await make();
    t.offline = true;
    expect(await pullTable(d, 'todos')).toBe('net');
    expect(await d.cache.getMeta('cursor:todos')).toBeUndefined();
  });

  it('闸设上了：停下，不写回', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    const gd = { ...d, gated: () => true };
    expect(await pullTable(gd, 'todos')).toBe('stopped');
    expect(await d.cache.allRows('todos')).toEqual([]);
  });
});

describe('整表重拉', () => {
  it('超过 25 天：整表；本机有、服务器已没有的行删掉（连同队列项），还没上服务器的不动', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= 2; n++) t.server.insert('todos', todo(n));
    await pullTable(d, 'todos');
    // 服务器上 uid(2) 已被硬删、墓碑也过期了（TC-B1-60）；本机还有一条离线新建、没发出去的
    t.server.table('todos').delete(uid(2));
    await d.outbox.enqueue({ table: 'todos', id: uid(9), op: 'insert', data: todo(9) });
    clock.t += FULL_RESYNC_AFTER_MS + 1;
    expect(await pullTable(d, 'todos')).toBe('ok');
    const ids = (await d.cache.allRows('todos')).map((r) => r.id).sort();
    expect(ids).toEqual([uid(1), uid(9)]);
    expect((await d.cache.getMeta('cursor:todos'))?.fullSyncAt).toBe(clock.t);
  });

  it('forceFull（换账号、SCHEMA_V 变了、服务器拒收）：不管游标，整表拉', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    await pullTable(d, 'todos');
    await d.cache.putRows('todos', [{ id: uid(5), server: { id: uid(5), rev: 1 }, view: { id: uid(5), rev: 1 } }]);
    expect(await pullTable(d, 'todos', true)).toBe('ok');
    expect(await d.cache.getRow('todos', uid(5))).toBeUndefined();
  });
});

describe('墓碑（0.29 续第 121 条⑤）', () => {
  it('增量拉墓碑：删本机这一行（server、view 两份）和它还没发的项；本机没有的 id 忽略', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= 2; n++) t.server.insert('todos', todo(n));
    await pullTable(d, 'todos');
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '没发' } });
    t.server.hardDelete('todos', uid(1));
    t.server.tombstones.push({ tbl: 'todos', id: uid(77), deleted_at: t.server.nextSynced() });   // 别人的 / 本机没有
    t.server.tombstones.push({ tbl: 'logs', id: uid(78), deleted_at: t.server.nextSynced() });    // 不是同步表
    expect(await pullTombstones(d)).toBe('ok');
    expect(await d.cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await d.cache.getRow('todos', uid(2))).toBeDefined();
    expect(await d.outbox.list()).toEqual([]);
    expect(collection('todos').get(uid(1))).toBeUndefined();
    const cur = await d.cache.getMeta('cursor:tombstones');
    expect(cur?.cursor).toBe(t.server.tombstones[2]?.deleted_at);
  });

  it('Realtime 的墓碑 INSERT 一样删；格式不对的忽略', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    await pullTable(d, 'todos');
    await applyRealtimeTombstone(d, { nope: 1 });
    await applyRealtimeTombstone(d, { tbl: 'todos', id: uid(1), deleted_at: '2026-10-29T00:00:00Z', user_id: 'u' });
    expect(await d.cache.getRow('todos', uid(1))).toBeUndefined();
  });
});

describe('Realtime 来的行、待补拉', () => {
  it('Realtime 的 UPDATE 合并进本机；比本机旧的 rev 忽略；不是同步表的忽略', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    await pullTable(d, 'todos');
    const newer = t.server.edit('todos', uid(1), { title: '新' });
    await applyRealtimeRow(d, 'todos', { ...newer });
    await applyRealtimeRow(d, 'todos', { ...newer, rev: 1, title: '晚到的旧值' });
    await applyRealtimeRow(d, 'logs', { id: 'x', rev: 1 });
    expect((await d.cache.getRow('todos', uid(1)))?.view).toMatchObject({ title: '新', rev: 2 });
  });

  it('解析不了的行记进待补拉；补拉时读成功的去掉、服务器已没有的去掉（K7 的 updateRefetch / clearRefetch）', async () => {
    let badOnce = true;
    const parse: ParseServerRows = (table, raw) => {
      const r = identityParse(table, raw);
      if (!badOnce) return r;
      badOnce = false;
      return { rows: r.rows.filter((x) => x.row.id !== uid(2)), bad: [uid(2)] };
    };
    const { d, t } = await make(parse);
    for (let n = 1; n <= 2; n++) t.server.insert('todos', todo(n));
    await pullTable(d, 'todos');
    expect(await d.cache.getMeta('refetch:todos')).toEqual([uid(2)]);

    await d.cache.setMeta('refetch:todos', [uid(2), uid(3)]);   // uid(3) 服务器上已经没有了
    expect(await refetchTable(d, 'todos', [uid(2), uid(3)])).toBe('ok');
    expect(await d.cache.getMeta('refetch:todos')).toBeUndefined();
    expect(await d.cache.getRow('todos', uid(2))).toBeDefined();
  });
});
