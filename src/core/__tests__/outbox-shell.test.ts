// R-229：同步读到隐私记行（或判断不了）但整行坏了时，K7 给只读空壳 {id, flag 列}，带 shell: true 和 minRev；
// outbox.applyServer 收到空壳：丢掉这一行的全部队列项（含发送失败区、inflight），view 只剩空壳，明文不能被 rebase 叠回来；
// 记 shell_rev，之后只收 rev > shell_rev 的行（K7 复审：晚到的同 rev 旧普通行不能把空壳盖掉）；日志只有表名、id、条数
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openCache, type ServerRow } from '../cache.ts';
import { createOutbox, type ServerRowInput } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { clock, seed, uid } from './outbox-fixtures.ts';

const note = (n: number) => ({ title: `公开标题${n}`, body: `公开正文${n}`, is_private: false, created_at: '2026-10-29T00:00:00Z' });
const shell = (n: number, minRev: number | null, flag: unknown = true): ServerRowInput => ({
  row: { id: uid(n), is_private: flag } as ServerRow,
  ro: true,
  shell: true,
  minRev,
});
const plain = (n: number, rev: number | undefined, title = '晚到的明文'): ServerRowInput => ({
  row: { ...note(n), id: uid(n), title, ...(rev === undefined ? {} : { rev }) } as ServerRow,
});

async function setupWithLog() {
  const { factory } = fakeIndexedDB();
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  const log = vi.fn();
  let seq = 0;
  const outbox = createOutbox(r.cache, { appVersion: '4.0.0', now: () => clock.t, newOpId: () => `op-${++seq}`, log });
  await outbox.boot();
  return { cache: r.cache, outbox, log };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('R-229：applyServer 收到隐私记只读空壳', () => {
  it('普通记＋带 title 的未发 patch（另有一条发送失败的）→ 空壳：view、server、outbox、集合里都找不到明文；日志只记表名、id、条数', async () => {
    const { cache, outbox, log } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1));
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '失败区里的标题' } });
    const first = await outbox.next();
    expect(await outbox.fail(first?.op_id ?? '', { status: 400, code: '23514' })).toBe('permanent');
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '没发的标题', body: '没发的正文' } });
    expect(outbox.getStatus()).toMatchObject({ pending: 1, failed: 1 });

    await outbox.applyServer('notes', [shell(1, null, 'unknown')]);

    const row = await cache.getRow('notes', uid(1));
    // minRev 为 null：门槛用本机旧 server 的 rev（seed 是 5）
    expect(row).toEqual({ id: uid(1), server: { id: uid(1), is_private: 'unknown' }, view: { id: uid(1), is_private: 'unknown' }, ro: true, shell_rev: 5, shell_inclusive: false });
    expect(JSON.stringify(row)).not.toMatch(/标题|正文|title|body/);
    expect(await outbox.list()).toEqual([]);
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(JSON.stringify(collection('notes').get(uid(1)))).not.toMatch(/标题|正文|title|body/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ act: 'outbox_vault_shell_drop', coll: 'notes', id: uid(1), dropped: 2 });
  });

  it('只丢这一行的队列项，别的行照常；只按 shell 标记认，不看列形状（只有 id＋flag 但没标记的只读行不当空壳）', async () => {
    const { cache, outbox, log } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1));
    await seed(cache, 'notes', uid(2), note(2));
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '改1' } });
    await outbox.enqueue({ table: 'notes', id: uid(2), op: 'patch', data: { title: '改2' } });
    await outbox.applyServer('notes', [shell(1, 6)]);
    expect((await outbox.list()).map((i) => i.id)).toEqual([uid(2)]);
    expect((await cache.getRow('notes', uid(2)))?.view).toMatchObject({ title: '改2' });

    log.mockClear();
    await outbox.applyServer('notes', [{ row: { id: uid(2), is_private: true, rev: 6 } as ServerRow, ro: true }]);
    expect((await outbox.list()).map((i) => i.id)).toEqual([uid(2)]);
    expect((await cache.getRow('notes', uid(2)))?.shell_rev).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('门槛来自原始行 minRev（含等于）：更低 rev、没有 rev 的都不收；升级后同 rev 的好行能收、ro 去掉、不在 skipped（TC-B1-40）', async () => {
    const { cache, outbox } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1), 3);
    await outbox.applyServer('notes', [shell(1, 4)]);
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 4, shell_inclusive: true, ro: true });

    for (const late of [plain(1, 3), plain(1, undefined)]) {
      expect(await outbox.applyServer('notes', [late])).toEqual({ skipped: [uid(1)] });
      const r = await cache.getRow('notes', uid(1));
      expect(JSON.stringify(r)).not.toContain('晚到的明文');
      expect(r).toMatchObject({ ro: true, shell_rev: 4 });
    }

    expect(await outbox.applyServer('notes', [plain(1, 4, '升级后读得懂的标题')])).toEqual({ skipped: [] });
    const ok = await cache.getRow('notes', uid(1));
    expect(ok?.view).toMatchObject({ title: '升级后读得懂的标题', rev: 4 });
    expect(ok?.ro).toBeUndefined();
    expect(ok?.shell_rev).toBeUndefined();
    expect(ok?.shell_inclusive).toBeUndefined();
  });

  it('门槛是拿本机旧 rev 补的（minRev 为 null，严格大于）：同 rev 的旧行仍拒，更高 rev 的好行恢复正常', async () => {
    const { cache, outbox } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1), 5);
    await outbox.applyServer('notes', [shell(1, null)]);
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 5, shell_inclusive: false });
    expect(await outbox.applyServer('notes', [plain(1, 5)])).toEqual({ skipped: [uid(1)] });
    expect(JSON.stringify(await cache.getRow('notes', uid(1)))).not.toContain('晚到的明文');
    expect(await outbox.applyServer('notes', [plain(1, 6, '新标题')])).toEqual({ skipped: [] });
    expect((await cache.getRow('notes', uid(1)))?.view).toMatchObject({ title: '新标题', rev: 6 });
  });

  it('本机原来没有这一行：不建空壳，进 skipped（同一个读写事务里判断）；同批别的行照收', async () => {
    const { cache, outbox, log } = await setupWithLog();
    expect(await outbox.applyServer('notes', [shell(1, 4), plain(2, 1)])).toEqual({ skipped: [uid(1)] });
    expect(await cache.getRow('notes', uid(1))).toBeUndefined();
    expect((await cache.getRow('notes', uid(2)))?.view).toMatchObject({ title: '晚到的明文' });
    expect(log).not.toHaveBeenCalled();
  });

  it('晚到的空壳（minRev 比本机已收正常行的 rev 小）：跳过、进 skipped，不盖正常行、不删队列；minRev 为 null 时照样建空壳', async () => {
    const { cache, outbox, log } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1), 7);
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '我改的' } });
    expect(await outbox.applyServer('notes', [shell(1, 6)])).toEqual({ skipped: [uid(1)] });
    const r = await cache.getRow('notes', uid(1));
    expect(r?.view).toMatchObject({ title: '我改的', rev: 7 });
    expect(r?.ro).toBeUndefined();
    expect(r?.shell_rev).toBeUndefined();
    expect((await outbox.list()).length).toBe(1);
    expect(log).not.toHaveBeenCalled();

    expect(await outbox.applyServer('notes', [shell(1, 7)])).toEqual({ skipped: [] });   // 同 rev：建空壳
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 7, shell_inclusive: true, ro: true });
  });

  it('门槛取 minRev、本机旧 rev、旧门槛里最大的；同 rev 时含等于优先；都取不到（本机有行但旧 server 没有 rev）为 0、严格大于', async () => {
    const { cache, outbox } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1), 7);
    await outbox.applyServer('notes', [shell(1, null)]);
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 7, shell_inclusive: false });
    await outbox.applyServer('notes', [shell(1, 4)]);   // 已经是空壳了：旧门槛 7 更大，照旧严格大于
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 7, shell_inclusive: false });
    await outbox.applyServer('notes', [shell(1, 7)]);
    expect(await cache.getRow('notes', uid(1))).toMatchObject({ shell_rev: 7, shell_inclusive: true });

    // 本机有行、旧 server 没有 rev（server 为 null 的离线新建；server 里缺 rev），minRev 也是 null
    await cache.putRows('notes', [{ id: uid(2), server: null, view: { ...note(2), id: uid(2) } }]);
    await cache.putRows('notes', [{ id: uid(3), server: { ...note(3), id: uid(3) }, view: { ...note(3), id: uid(3) } }]);
    await outbox.applyServer('notes', [shell(2, null), shell(3, null)]);
    expect(await cache.getRow('notes', uid(2))).toMatchObject({ shell_rev: 0, shell_inclusive: false });
    expect(await cache.getRow('notes', uid(3))).toMatchObject({ shell_rev: 0, shell_inclusive: false });
    expect(await outbox.applyServer('notes', [plain(2, undefined)])).toEqual({ skipped: [uid(2)] });
    expect(await outbox.applyServer('notes', [plain(2, 0)])).toEqual({ skipped: [uid(2)] });
    expect(await outbox.applyServer('notes', [plain(2, 1)])).toEqual({ skipped: [] });
  });

  it('inflight 的项被空壳删掉以后：ack、fail 回来都不做事（不写回明文、不发事件、不动空壳）', async () => {
    const { cache, outbox } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1));
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '发送中的标题' } });
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { body: '排着的正文' } });
    const a = await outbox.next();
    expect(a?.state).toBe('inflight');
    const events: string[] = [];
    outbox.onEvent((e) => events.push(e.type));
    await outbox.applyServer('notes', [shell(1, 6)]);
    expect(await outbox.list()).toEqual([]);
    const before = await cache.getRow('notes', uid(1));

    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 7, prev_rev: 6 });
    expect(await outbox.fail(a?.op_id ?? '', { status: 400, code: '23514' })).toBe('permanent');
    expect(await cache.getRow('notes', uid(1))).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/发送中|排着/);
    expect(await outbox.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('不是空壳的只读行（普通行带不认识的枚举，列是全的）：队列项保留、照常叠上', async () => {
    const { cache, outbox, log } = await setupWithLog();
    await seed(cache, 'notes', uid(1), note(1));
    await outbox.enqueue({ table: 'notes', id: uid(1), op: 'patch', data: { title: '我改的' } });
    await outbox.applyServer('notes', [{ row: { ...note(1), id: uid(1), category_source: 'unknown', rev: 6 } as ServerRow, ro: true }]);
    expect((await outbox.list()).length).toBe(1);
    expect((await cache.getRow('notes', uid(1)))?.view).toMatchObject({ title: '我改的' });
    expect(log).not.toHaveBeenCalled();
  });
});
