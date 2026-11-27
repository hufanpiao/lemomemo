// K8 审查必改 2（整表重拉不误删）、必改 6（翻页：只有这一页不满才算拉完）及建议的回归：
// 翻页中途失败游标不动、同一时间戳跨页、MAX_PAGES、满页取不到翻页位置、墓碑同样、整表 since === null 且游标从头算、
// rememberBad 只去掉读成功的、noConflict 列不报冲突
import { beforeEach, describe, expect, it } from 'vitest';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { pullTable, pullTombstones, rememberBad, TOMBSTONE_CURSOR, type PullDeps } from '../pull.ts';
import type { ParseServerRows } from '../types.ts';
import { fakeTransport, identityParse, type FakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

async function make(over: Partial<PullDeps> = {}): Promise<{ d: PullDeps & { logs: string[] }; t: FakeTransport }> {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  const logs: string[] = [];
  return { t, d: { cache, outbox, transport: t, parseRows: identityParse, gated: () => false, now: () => clock.t, log: (c) => logs.push(c), logs, pageSize: 2, ...over } };
}

describe('必改 2：整表重拉不误删', () => {
  it('拉取期间另一个标签页确认了 insert 又改了一次（审查探针 P2）：本机行和未发的 patch 都还在', async () => {
    const { d, t } = await make({ pageSize: 500 });
    t.server.insert('todos', todo(1));
    await d.outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    // 快照之后：拉到的这一页里还没有 uid(2)；这时另一个标签页发出并确认了 uid(2)，用户又改了标题
    const origPull = t.pullRows.bind(t);
    t.pullRows = async (table, q) => {
      const res = await origPull(table, q);
      const item = await d.outbox.next();
      if (item) {
        const r = t.server.insert('todos', { ...item.data });
        await d.outbox.ack(item.op_id, { status: 'ok', rev: r.rev, prev_rev: null });
        await d.outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '刚改的标题' } });
      }
      return res;
    };
    expect(await pullTable(d, 'todos', true)).toBe('ok');
    expect(await d.cache.getRow('todos', uid(2))).toBeDefined();
    expect((await d.outbox.list()).map((i) => i.op)).toEqual(['patch']);
  });

  it('快照里有、这次没拉到、rev 没变的才删；rev 变了的、有 inflight 项的不删', async () => {
    const { d, t } = await make({ pageSize: 500 });
    for (let n = 1; n <= 3; n++) {
      const r = t.server.insert('todos', todo(n));
      await seed(d.cache, 'todos', uid(n), todo(n), r.rev);
    }
    for (let n = 1; n <= 3; n++) t.server.table('todos').delete(uid(n));   // 服务器上三行都没了（硬删、没有墓碑）
    // uid(2)：拉取期间本机拿到了新 rev（Realtime 来的）；uid(3)：有一项正在发（inflight）
    await d.outbox.enqueue({ table: 'todos', id: uid(3), op: 'patch', data: { title: 'x' } });
    await d.outbox.next();
    const origPull = t.pullRows.bind(t);
    t.pullRows = async (table, q) => {
      await d.outbox.applyServer('todos', [{ row: { ...todo(2), id: uid(2), rev: 9 } }]);
      return origPull(table, q);
    };
    expect(await pullTable(d, 'todos', true)).toBe('ok');
    expect(await d.cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await d.cache.getRow('todos', uid(2))).toBeDefined();
    expect(await d.cache.getRow('todos', uid(3))).toBeDefined();
  });

  it('整表：请求 since === null；游标从头算（旧游标比服务器的新也会被改小）', async () => {
    const { d, t } = await make();
    t.server.insert('todos', todo(1));
    await d.cache.setMeta('cursor:todos', { cursor: '2099-01-01T00:00:00.000Z', fullSyncAt: 0 });
    expect(await pullTable(d, 'todos', true)).toBe('ok');
    expect(t.pullQueries.every((q) => q.since === null)).toBe(true);
    expect((await d.cache.getMeta('cursor:todos'))?.cursor).toBe(t.server.rows('todos')[0]?.synced_at);
  });
});

describe('必改 6：翻页', () => {
  it('翻页中途失败：返回 net，游标不动、不删行', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= 5; n++) t.server.insert('todos', todo(n));
    const ghost = todo(9);
    await seed(d.cache, 'todos', uid(9), ghost, 1);   // 服务器上没有的本机行：整表失败时不能删
    t.pullFailAt = { n: 2 };
    expect(await pullTable(d, 'todos', true)).toBe('net');
    expect(await d.cache.getMeta('cursor:todos')).toBeUndefined();
    expect(await d.cache.getRow('todos', uid(9))).toBeDefined();
  });

  it('同一时间戳跨页：按 (synced_at, id) 翻页，一行不漏', async () => {
    const { d, t } = await make();
    t.server.sameSynced = true;
    for (let n = 1; n <= 5; n++) t.server.insert('todos', todo(n));
    expect(new Set(t.server.rows('todos').map((r) => r.synced_at)).size).toBe(1);
    expect(await pullTable(d, 'todos')).toBe('ok');
    expect((await d.cache.allRows('todos')).length).toBe(5);
    expect(t.pullQueries.length).toBe(3);   // 2 + 2 + 1：最后一页不满才算拉完
  });

  it('刚好满页：再拉一页空的才算拉完', async () => {
    const { d, t } = await make();
    for (let n = 1; n <= 4; n++) t.server.insert('todos', todo(n));
    expect(await pullTable(d, 'todos')).toBe('ok');
    expect(t.pullQueries.length).toBe(3);
  });

  it('满 MAX_PAGES 页还没拉完：net、记 sync_max_pages、不写游标、不删行', async () => {
    const { d, t } = await make({ maxPages: 2 });
    for (let n = 1; n <= 5; n++) t.server.insert('todos', todo(n));
    await seed(d.cache, 'todos', uid(9), todo(9), 1);
    expect(await pullTable(d, 'todos', true)).toBe('net');
    expect(d.logs).toEqual(['sync_max_pages']);
    expect(await d.cache.getMeta('cursor:todos')).toBeUndefined();
    expect(await d.cache.getRow('todos', uid(9))).toBeDefined();
  });

  it('满页但取不到翻页位置（行没有 synced_at）：net、记 sync_page_no_cursor', async () => {
    const { d, t } = await make();
    t.pullRows = () => Promise.resolve({ ok: true, value: [{ id: uid(1) }, { id: uid(2) }] });
    expect(await pullTable(d, 'todos')).toBe('net');
    expect(d.logs).toEqual(['sync_page_no_cursor']);
    expect(await d.cache.getMeta('cursor:todos')).toBeUndefined();
  });

  it('墓碑同样：满 MAX_PAGES 页、翻页中途失败都不写游标', async () => {
    const { d, t } = await make({ maxPages: 2 });
    for (let n = 1; n <= 5; n++) t.server.tombstones.push({ tbl: 'todos', id: uid(n), deleted_at: `2026-10-29T00:00:0${n}.000Z` });
    expect(await pullTombstones(d)).toBe('net');
    expect(d.logs).toEqual(['sync_max_pages']);
    expect(await d.cache.getMeta(TOMBSTONE_CURSOR)).toBeUndefined();

    const e = await make();
    for (let n = 1; n <= 5; n++) e.t.server.tombstones.push({ tbl: 'todos', id: uid(n), deleted_at: `2026-10-29T00:00:0${n}.000Z` });
    const orig = e.t.pullTombstones.bind(e.t);
    let k = 0;
    e.t.pullTombstones = (q) => (++k === 2 ? Promise.resolve({ ok: false, error: { network: true } }) : orig(q));
    expect(await pullTombstones(e.d)).toBe('net');
    expect(await e.d.cache.getMeta(TOMBSTONE_CURSOR)).toBeUndefined();
    expect(await pullTombstones(e.d)).toBe('ok');
    expect((await e.d.cache.getMeta(TOMBSTONE_CURSOR))?.cursor).toBe('2026-10-29T00:00:05.000Z');
  });
});

describe('建议', () => {
  it('rememberBad：同一个 id 既在 rows（只读空壳）又在 bad 里，不从待补拉去掉（照 ingest.ts）', async () => {
    const { d } = await make();
    await rememberBad(d.cache, 'todos', { rows: [{ row: { id: uid(1) } }, { row: { id: uid(2) } }], bad: [uid(1)] });
    expect(await d.cache.getMeta('refetch:todos' as never)).toEqual([uid(1)]);
    const parse: ParseServerRows = (_t, raw) => ({ rows: identityParse('todos', raw).rows, bad: [] });
    await rememberBad(d.cache, 'todos', parse('todos', [{ id: uid(1) }]));
    expect(await d.cache.getMeta('refetch:todos' as never) ?? []).toEqual([]);
  });

  it('假服务器：noConflict 列（notified_for、snooze_at、updated_at）别的设备改过也不报冲突', () => {
    const t = fakeTransport();
    t.server.insert('anniversaries', { id: uid(1), name: 'a', notified_for: null, snooze_at: null, updated_at: 1 });
    t.server.edit('anniversaries', uid(1), { notified_for: 'x', snooze_at: 5, updated_at: 2, name: 'b' });
    const r = t.server.applyPatch({ p_table: 'anniversaries', p_id: uid(1), p_patch: { notified_for: 'y', snooze_at: 6, updated_at: 3, name: 'c' }, p_base_rev: 1, p_op_id: 'o', p_own_revs: [] });
    expect(r).toMatchObject({ status: 'conflict', conflicts: ['name'] });
  });

  it('假服务器：own_revs 超过 20 个当空', () => {
    const t = fakeTransport();
    t.server.insert('todos', todo(1));
    const e = t.server.edit('todos', uid(1), { title: 'b' });
    const own = Array.from({ length: 21 }, (_, i) => (i === 0 ? e.rev : 100 + i));
    expect(t.server.applyPatch({ p_table: 'todos', p_id: uid(1), p_patch: { title: 'c' }, p_base_rev: 1, p_op_id: 'o1', p_own_revs: own }).status).toBe('conflict');
    expect(t.server.applyPatch({ p_table: 'todos', p_id: uid(1), p_patch: { title: 'd' }, p_base_rev: 1, p_op_id: 'o2', p_own_revs: [e.rev, 3] }).status).toBe('ok');
  });
});
