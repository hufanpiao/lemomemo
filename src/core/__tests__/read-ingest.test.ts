// 宽容读取落库（架构 0.27 第 1 点；数据字典 10.3 待补拉列表）：TC-B1-34～39 的本机缓存一半，TC-B1-40 只读行恢复
// 纯函数部分见 read-lenient.test.ts；界面（行尾只读标记、写入入口拦下、重复事项横幅）在 B2 / B4 / B5 验
import { beforeEach, describe, expect, it } from 'vitest';
import { UNKNOWN } from '../../../shared/schema/rows-read.ts';
import { META } from '../cache-schema.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearRefetch, ingestServerRows, MAX_REFETCH, updateRefetch } from '../read/ingest.ts';
import type { ReadLog } from '../read/lenient.ts';
import { clearAllCollections, collection } from '../store.ts';
import { clock, setup, uid } from './outbox-fixtures.ts';
import { SECRET, serverNote, serverTodo } from './read-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

async function env() {
  const { cache, outbox } = await setup();
  const logs: ReadLog[] = [];
  return { cache, outbox, logs, deps: { cache, outbox, log: (e: ReadLog) => logs.push(e) } };
}

describe('ingestServerRows', () => {
  it('TC-B1-34：一行枚举不认识：本机这一行 ro、值为 unknown；其他行照常；写入被拦下（readonly_row）', async () => {
    const { cache, outbox, deps } = await env();
    const b = await ingestServerRows(deps, 'todos', [serverTodo(1), serverTodo(2, { source: 'watch' })]);
    expect(b.readonlyIds).toEqual([uid(2)]);
    const ok = await cache.getRow('todos', uid(1));
    const ro = await cache.getRow('todos', uid(2));
    expect(ok?.ro).toBeUndefined();
    expect(ok?.view?.['title']).toBe('待办1');
    expect(ro?.ro).toBe(true);
    expect(ro?.server?.['source']).toBe(UNKNOWN);
    expect(collection('todos').get(uid(2))).toBeDefined();   // 只读行照样显示
    await expect(outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '改' } })).rejects.toThrow(OutboxRejectError);
    await expect(outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '改' } })).rejects.toThrow('readonly_row');
  });

  it('TC-B1-35：普通行带不认识的列 qa_new：留在 server 副本；改 title 的 patch 只发 title，不把 qa_new 写空', async () => {
    const { cache, outbox, deps } = await env();
    await ingestServerRows(deps, 'todos', [serverTodo(1, { qa_new: 'v2' })]);
    expect((await cache.getRow('todos', uid(1)))?.server?.['qa_new']).toBe('v2');
    const item = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '新标题' } });
    expect(item?.data).toEqual({ title: '新标题' });
    expect(item?.base_rev).toBe(3);
    const row = await cache.getRow('todos', uid(1));
    expect(row?.view).toMatchObject({ title: '新标题', qa_new: 'v2' });
    expect(row?.server?.['qa_new']).toBe('v2');
  });

  it('TC-B1-36：隐私记行带不认识的明文列 qa_plain：本机缓存里只有 cipherCols 和 neutralCols', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, true, { qa_plain: SECRET })]);
    const row = await cache.getRow('notes', uid(1));
    expect(row?.server?.['qa_plain']).toBeUndefined();
    expect(row?.server?.['body_enc']).toBe('ZW5j');
    expect(row?.server?.['title']).toBeUndefined();
    expect(JSON.stringify(await cache.allRows('notes'))).not.toContain(SECRET);
  });

  it('TC-B1-37：flag 列解析不了：按隐私记行处理，本机不缓存明文，只读', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { is_private: 'maybe', title: SECRET, body: SECRET, qa_plain: SECRET })]);
    const row = await cache.getRow('notes', uid(1));
    expect(row?.ro).toBe(true);
    expect(row?.server?.['is_private']).toBe(UNKNOWN);
    expect(JSON.stringify(await cache.allRows('notes'))).not.toContain(SECRET);
  });

  it('TC-B1-38：一行解析不了：只丢这一行；id 进待补拉；日志一条 row_unknown（表名、列名，不记内容）；以后读成功了从待补拉去掉', async () => {
    const { cache, deps, logs } = await env();
    await ingestServerRows(deps, 'todos', [serverTodo(1), serverTodo(2, { title: { text: SECRET } }), serverTodo(3)]);
    expect((await cache.allRows('todos')).map((r) => r.id).sort()).toEqual([uid(1), uid(3)]);
    expect(await cache.getMeta('refetch:todos')).toEqual([uid(2)]);
    expect(logs).toEqual([{ act: 'row_unknown', coll: 'todos', item_id: uid(2), fields: ['title'], code: 'bad_type' }]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);

    // 同一行再坏一次不重复记
    await ingestServerRows(deps, 'todos', [serverTodo(2, { done: 3 })]);
    expect(await cache.getMeta('refetch:todos')).toEqual([uid(2)]);

    // 下次启动单独补拉（K8）：这次读成功了 → 写进缓存、从待补拉去掉、键删掉
    await ingestServerRows(deps, 'todos', [serverTodo(2)]);
    expect((await cache.getRow('todos', uid(2)))?.view?.['title']).toBe('待办2');
    expect(await cache.getMeta('refetch:todos')).toBeUndefined();
  });

  it('解析不了、本机原来有的行：本机那一行不动（只丢这一批里的这一行）', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'todos', [serverTodo(1)]);
    await ingestServerRows(deps, 'todos', [serverTodo(1, { rev: 9, important: 'very' })]);
    const row = await cache.getRow('todos', uid(1));
    expect(row?.server?.['rev']).toBe(3);
    expect(await cache.getMeta('refetch:todos')).toEqual([uid(1)]);
  });

  it('TC-B1-39：新列、新枚举、repeat、隐私记新明文列混在一批：整批不拒收，只读的只读，明文不进本机', async () => {
    const { cache, deps } = await env();
    const t = await ingestServerRows(deps, 'todos', [
      serverTodo(1, { qa_new: 1 }), serverTodo(2, { ai_status: 'brand-new' }), serverTodo(3, { short_by: 'model' }), serverTodo(4, { repeat: { freq: 'daily' } }),
    ]);
    expect(t.dropped).toEqual([]);
    expect((await cache.allRows('todos')).filter((r) => r.ro).map((r) => r.id).sort()).toEqual([uid(3), uid(4)]);
    await ingestServerRows(deps, 'notes', [serverNote(5, true, { qa_plain: SECRET }), serverNote(6, false)]);
    expect(await cache.allRows('notes')).toHaveLength(2);
    expect(JSON.stringify(await cache.allRows('notes'))).not.toContain(SECRET);
  });

  // SCHEMA_V 变了就整表重拉由 boot.ts（K6）判断、K8 执行；这里只测重拉回来的同一行（rev 不变）能恢复
  it('TC-B1-40（本机一半）：升级后整表重拉同一个 rev 的行，之前只读的行读成正常值，ro 去掉、又能改', async () => {
    const { cache, outbox, deps } = await env();
    await ingestServerRows(deps, 'todos', [serverTodo(1, { source: 'watch' })]);
    expect((await cache.getRow('todos', uid(1)))?.ro).toBe(true);
    await ingestServerRows(deps, 'todos', [serverTodo(1)]);   // 同一个 rev（3）
    expect((await cache.getRow('todos', uid(1)))?.server?.['source']).toBe('page');
    expect((await cache.getRow('todos', uid(1)))?.ro).toBeUndefined();
    await expect(outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'ok' } })).resolves.toBeTruthy();
  });

  it('R-229：本机原有带明文的普通记，服务器传来 is_private=true 但 rev 坏了：本机只剩 id + is_private、只读、进待补拉，明文清掉', async () => {
    const { cache, deps, logs } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { title: SECRET, body: SECRET })]);
    expect(JSON.stringify(await cache.getRow('notes', uid(1)))).toContain(SECRET);
    const b = await ingestServerRows(deps, 'notes', [serverNote(1, true, { rev: 'x', qa_plain: SECRET })]);
    expect(b.dropped).toEqual([{ id: uid(1), code: 'bad_type', cols: ['rev'] }]);
    const row = await cache.getRow('notes', uid(1));
    expect(row?.server).toEqual({ id: uid(1), is_private: true });
    expect(row?.view).toEqual({ id: uid(1), is_private: true });
    expect(row?.ro).toBe(true);
    expect(JSON.stringify(await cache.allRows('notes'))).not.toContain(SECRET);
    expect(await cache.getMeta('refetch:notes')).toEqual([uid(1)]);
    expect(logs).toHaveLength(1);
    expect(collection('notes').get(uid(1))).toEqual({ id: uid(1), is_private: true });
  });

  it('R-229：判断不了的行坏了：空壳的 flag 列是 unknown；普通行坏了本机原有那份不动', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, false), serverNote(2, false)]);
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { is_private: 'maybe', rev: 'x' }), serverNote(2, false, { rev: 'x' })]);
    expect((await cache.getRow('notes', uid(1)))?.server).toEqual({ id: uid(1), is_private: UNKNOWN });
    expect((await cache.getRow('notes', uid(2)))?.server?.['title']).toBe('随手记2');
    expect(await cache.getMeta('refetch:notes')).toEqual([uid(1), uid(2)]);
  });

  // 依赖 K6：applyServerRows 在同一读写事务里发现本机没有这一行，就不建空壳、把它放进 skipped（第三轮复审新必改 2）
  it('R-229：本机原来没有这一行：不建空壳，只进待补拉、记日志', async () => {
    const { cache, outbox, deps, logs } = await env();
    const skippedSeen: string[][] = [];
    const spy = { applyServer: async (t: string, rows: Parameters<typeof outbox.applyServer>[1]) => {
      const r = await outbox.applyServer(t, rows);
      skippedSeen.push(r.skipped);
      return r;
    } };
    const b = await ingestServerRows({ ...deps, outbox: spy }, 'notes', [serverNote(1, true, { rev: 'x' }), serverNote(2, false)]);
    expect(await cache.getRow('notes', uid(1))).toBeUndefined();
    expect((await cache.getRow('notes', uid(2)))?.server?.['title']).toBe('随手记2');
    expect(skippedSeen).toEqual([[uid(1)]]);
    expect(b.readonlyIds).toEqual([]);
    expect(await cache.getMeta('refetch:notes')).toEqual([uid(1)]);
    expect(logs.map((l) => [l.item_id, l.code])).toEqual([[uid(1), 'bad_type']]);
  });

  // 依赖 K6 的 applyServerRows 认 shell、记门槛（shell_rev、shell_inclusive）：
  // 门槛来自 minRev 时收 rev ≥ minRev（同 rev 的好行就是这一行本身）；拿本机旧 rev 补的门槛严格大于（同 rev 就是本机原来那份旧行）
  it('R-229：门槛来自 minRev：晚到的旧行盖不掉空壳；同 rev 读得好的行（补拉、整表重拉）照收', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { title: SECRET, rev: 3 })]);
    await ingestServerRows(deps, 'notes', [serverNote(1, true, { rev: 4, user_id: 5 })]);   // 坏行 → 空壳，minRev 4
    expect((await cache.getRow('notes', uid(1)))?.server).toEqual({ id: uid(1), is_private: true });
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { title: SECRET, rev: 3 })]);   // 晚到的旧行
    expect(JSON.stringify(await cache.getRow('notes', uid(1)))).not.toContain(SECRET);
    expect((await cache.getRow('notes', uid(1)))?.ro).toBe(true);
    expect(await cache.getMeta('refetch:notes')).toEqual([uid(1)]);   // 没收的行不算读成功，待补拉还在
    await ingestServerRows(deps, 'notes', [serverNote(1, true, { rev: 4 })]);   // 补拉回来同 rev 的好行照收
    const row = await cache.getRow('notes', uid(1));
    expect(row?.server?.['rev']).toBe(4);
    expect(row?.server?.['body_enc']).toBe('ZW5j');
    expect(row?.ro).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(await cache.getMeta('refetch:notes')).toBeUndefined();
  });

  it('R-229：原始行 rev 无效（minRev 为 null），门槛拿本机旧 rev 补：同 rev 的旧普通行也不收，更高 rev 的才收', async () => {
    const { cache, deps } = await env();
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { title: SECRET, rev: 3 })]);
    await ingestServerRows(deps, 'notes', [serverNote(1, true, { rev: 'x' })]);   // 坏行 → 空壳，minRev null，门槛 = 本机 rev 3、严格大于
    expect((await cache.getRow('notes', uid(1)))?.server).toEqual({ id: uid(1), is_private: true });
    await ingestServerRows(deps, 'notes', [serverNote(1, false, { title: SECRET, rev: 3 })]);   // 同 rev：本机原来那份旧行
    expect(JSON.stringify(await cache.getRow('notes', uid(1)))).not.toContain(SECRET);
    expect(await cache.getMeta('refetch:notes')).toEqual([uid(1)]);
    await ingestServerRows(deps, 'notes', [serverNote(1, true, { rev: 4 })]);
    expect((await cache.getRow('notes', uid(1)))?.server?.['rev']).toBe(4);
    expect(await cache.getMeta('refetch:notes')).toBeUndefined();
  });

  it('不认识的表：什么都不写，一条 table_unknown 日志', async () => {
    const { cache, deps, logs } = await env();
    await ingestServerRows(deps, 'habits', [{ id: uid(1) }]);
    expect(logs.map((l) => l.code)).toEqual(['table_unknown']);
    expect(await cache.tx([META], 'readonly', (t) => t.getAll(META))).toEqual([]);
  });
});

describe('待补拉列表', () => {
  it('追加去重、去掉、空了删键；最多 MAX_REFETCH 条（丢最早的）；clearRefetch 去掉服务器已经没有的', async () => {
    const { cache } = await setup();
    expect(await updateRefetch(cache, 'todos', ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(await updateRefetch(cache, 'todos', ['c'], ['a'])).toEqual(['b', 'c']);
    expect(await clearRefetch(cache, 'todos', ['b', 'c'])).toEqual([]);
    expect(await cache.getMeta('refetch:todos')).toBeUndefined();
    const many = Array.from({ length: MAX_REFETCH + 3 }, (_, i) => `id${i}`);
    const kept = await updateRefetch(cache, 'events', many);
    expect(kept).toHaveLength(MAX_REFETCH);
    expect(kept[0]).toBe('id3');
  });

  it('两路并发（拉取和 Realtime 同时到）：add、remove 都不丢', async () => {
    const { cache } = await setup();
    await updateRefetch(cache, 'todos', ['a', 'b']);
    await Promise.all([
      updateRefetch(cache, 'todos', ['c'], ['a']),
      updateRefetch(cache, 'todos', ['d'], ['b']),
      updateRefetch(cache, 'todos', ['e']),
    ]);
    expect([...((await cache.getMeta('refetch:todos')) ?? [])].sort()).toEqual(['c', 'd', 'e']);
  });

  it('meta 里的值不是数组（被写坏）：按空处理，非字符串项去掉', async () => {
    const { cache } = await setup();
    await cache.tx([META], 'readwrite', (t) => t.put(META, { key: 'refetch:todos', value: 'oops' }));
    expect(await updateRefetch(cache, 'todos', ['a'])).toEqual(['a']);
    await cache.tx([META], 'readwrite', (t) => t.put(META, { key: 'refetch:events', value: ['x', 3, null] }));
    expect(await updateRefetch(cache, 'events', ['y'])).toEqual(['x', 'y']);
    await cache.tx([META], 'readwrite', (t) => t.put(META, { key: 'refetch:notes', value: { a: 1 } }));
    expect(await updateRefetch(cache, 'notes', [], ['a'])).toEqual([]);
  });

  it('没有要改的：不开读写事务（平时每次拉取都会调）', async () => {
    const { cache, outbox } = await setup();
    await updateRefetch(cache, 'todos', ['a']);
    const modes: string[] = [];
    const orig = cache.tx.bind(cache);
    const spy: typeof cache.tx = (s, m, f, o) => {
      modes.push(m);
      return orig(s, m, f, o);
    };
    const c = { ...cache, tx: spy, getMeta: cache.getMeta };
    await updateRefetch(c, 'todos', ['a'], ['zzz']);
    await updateRefetch(c, 'todos', [], []);
    expect(modes.filter((m) => m === 'readwrite')).toEqual([]);
    await ingestServerRows({ cache: c, outbox }, 'todos', []);
    expect(modes.filter((m) => m === 'readwrite')).toEqual([]);
  });
});
