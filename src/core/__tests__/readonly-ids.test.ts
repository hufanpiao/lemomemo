// 只读行 id（FA-2 只读行界面；架构 0.27 第 1 点）：core/store 的 readonlyIds，跟着 view 一起从数据层推进来
// • store：只变化时换 Set、通知；clearAllCollections 一起清
// • applyServer（K7 宽容读取的 ro）写进去、变回可写时去掉；enqueue 不动它；reloadCollections 跟着库里的 ro 走
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache } from '../cache.ts';
import { clearAllCollections, collection, readonlyIds } from '../store.ts';
import { reloadCollections } from '../sync/reload.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('store 的 readonlyIds', () => {
  it('set / remove / clear；没变化时快照引用不变、不通知；clearAllCollections 一起清', () => {
    const r = readonlyIds('todos');
    const l = vi.fn();
    r.subscribe(l);
    const s0 = r.getSnapshot();
    r.set([{ id: 'a', ro: false }]);
    r.remove(['a']);
    expect(r.getSnapshot()).toBe(s0);
    expect(l).not.toHaveBeenCalled();
    r.set([{ id: 'a', ro: true }, { id: 'b', ro: true }]);
    expect([...r.getSnapshot()].sort()).toEqual(['a', 'b']);
    r.set([{ id: 'a', ro: false }]);
    expect([...r.getSnapshot()]).toEqual(['b']);
    r.remove(['b']);
    expect(r.getSnapshot().size).toBe(0);
    r.set([{ id: 'c', ro: true }]);
    clearAllCollections();
    expect(readonlyIds('todos').getSnapshot().size).toBe(0);
    // 每次 readonlyIds() 拿到的是同一个 ro:todos 集合上的薄包装：快照稳定、订阅仍有效
    expect(readonlyIds('todos').getSnapshot()).toBe(r.getSnapshot());
    readonlyIds('todos').set([{ id: 'd', ro: true }]);
    expect(r.getSnapshot().has('d')).toBe(true);
    expect(l).toHaveBeenCalled();
  });
});

describe('数据层推只读标记', () => {
  it('applyServer 带 ro：集合里有这一行、只读 id 里也有；服务器回来不再只读就去掉', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.applyServer('todos', [{ row: { ...todo(1), id: uid(1), repeat: { freq: 'week' }, rev: 6 }, ro: true }]);
    expect(collection('todos').get(uid(1))).toBeTruthy();
    expect(readonlyIds('todos').getSnapshot().has(uid(1))).toBe(true);
    await outbox.applyServer('todos', [{ row: { ...todo(1), id: uid(1), rev: 7 } }]);
    expect(readonlyIds('todos').getSnapshot().has(uid(1))).toBe(false);
  });

  it('只读 id 先于集合写好：集合通知的那一刻，订阅方读到的已经是新的只读标记', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(2), todo(2), 5);
    const seen: boolean[] = [];
    collection('todos').subscribe(() => seen.push(readonlyIds('todos').getSnapshot().has(uid(2))));
    await outbox.applyServer('todos', [{ row: { ...todo(2), id: uid(2), rev: 6 }, ro: true }]);
    expect(seen).toEqual([true]);
  });

  it('别的行的写入（enqueue）不动只读 id', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(3), todo(3), 5);
    await outbox.applyServer('todos', [{ row: { ...todo(3), id: uid(3), rev: 6 }, ro: true }]);
    await outbox.enqueue({ table: 'todos', id: uid(4), op: 'insert', data: todo(4) });
    expect([...readonlyIds('todos').getSnapshot()]).toEqual([uid(3)]);
  });

  it('reloadCollections：按库里的 ro 写只读 id；库里没了的行去掉', async () => {
    let rows = [
      { id: 'r1', view: { id: 'r1' }, ro: true },
      { id: 'r2', view: { id: 'r2' } },
    ];
    const cache = { syncTables: ['events'], isClosed: () => false, allRows: async () => rows } as unknown as Cache;
    await reloadCollections(cache, null);
    expect([...readonlyIds('events').getSnapshot()]).toEqual(['r1']);
    rows = [{ id: 'r2', view: { id: 'r2' } }];
    await reloadCollections(cache, null);
    expect(readonlyIds('events').getSnapshot().size).toBe(0);
    expect(collection('events').get('r1')).toBeUndefined();
  });
});
