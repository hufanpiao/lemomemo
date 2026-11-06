// outbox 状态的 retryRecs（UNSYNCED-retry-ui，审查 L2、L3，11-05）：带提醒的记录里有能重发的发送失败项才算；
// gone、本机校验不过（invalid_row）不算；同一条记录里失败的那一项不带提醒、别的项带提醒，也算（整条记录一起重发）
import { beforeEach, describe, expect, it } from 'vitest';
import { canRetryUnsynced } from '../outbox-logic.ts';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const rec = (n: number): string => `todos:${uid(n)}`;

// 数据字典 10.4b（UNSYNCED-retry-codes，11-06）：重发必然同样失败的不给重试
const NO_RETRY = [
  'gone', 'invalid_row', 'validation',
  '23505', '23514', '23502', '22P02', '22001', '22007', '22023', '22000',
  'insert_conflict', 'vault_file_readonly', 'file_immutable', 'install_id_immutable',
  'PGRST100', 'PGRST102', 'PGRST128', 'PGRST199', 'http_413',
];
// 别处改了以后能过、或查不清的：保留重试
const RETRY = [
  'quota', 'note_not_writable', '23503', '42501', '25006', 'PGRST202', 'PGRST204', 'PGRST205', '42883', '42P01',
  'http_403', 'http_400', 'http_404', 'http_405', 'http_412',
  // 长得像但不在表里的：只认整串
  '2350', '235050', '22', '220011', 'PGRST1', 'PGRST10', 'PGRST1000', 'PGRST200', 'pgrst102', 'x23505', 'http_4130',
];

describe('canRetryUnsynced：数据字典 10.4b 的码表', () => {
  it.each(NO_RETRY)('%s 不给重试', (error) => {
    expect(canRetryUnsynced({ state: 'failed', error })).toBe(false);
  });
  it.each(RETRY)('%s 保留重试', (error) => {
    expect(canRetryUnsynced({ state: 'failed', error })).toBe(true);
  });
});

describe('canRetryUnsynced', () => {
  it('只认 failed；gone、invalid_row、validation 不算；其他错误码和没有码都算', () => {
    expect(canRetryUnsynced({ state: 'failed', error: '23503' })).toBe(true);
    expect(canRetryUnsynced({ state: 'failed', error: 'http_403' })).toBe(true);
    expect(canRetryUnsynced({ state: 'failed', error: null })).toBe(true);
    for (const error of ['gone', 'invalid_row', 'validation']) expect(canRetryUnsynced({ state: 'failed', error })).toBe(false);
    for (const state of ['pending', 'inflight']) expect(canRetryUnsynced({ state, error: '23503' })).toBe(false);
  });
});

describe('outbox 状态的 retryRecs', () => {
  it('永久失败带提醒的算；gone、invalid_row、不带提醒的不算（但前两种仍在 remindRecs 里）', async () => {
    const { cache, outbox } = await setup();
    for (const n of [1, 2, 3, 4]) await seed(cache, 'todos', uid(n), todo(n), 5);
    // 1：带提醒、23503；2：带提醒、gone；3：带提醒、本机校验不过；4：不带提醒、23503
    for (const n of [1, 2, 3]) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'patch', data: { title: `改${n}` }, remind: true });
    await outbox.enqueue({ table: 'todos', id: uid(4), op: 'patch', data: { title: '改4' } });
    for (let k = 0; k < 4; k++) {
      const it = await outbox.next();
      const f = it?.id === uid(2) ? { status: 409, code: 'gone' } : it?.id === uid(3) ? { code: 'invalid_row' } : { status: 409, code: '23503' };
      await outbox.fail(it?.op_id ?? '', { ...f, sid: null });
    }
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 4 });
    expect(outbox.getStatus().remindRecs).toEqual(new Set([rec(1), rec(2), rec(3)]));
    expect(outbox.getStatus().retryRecs).toEqual(new Set([rec(1)]));
  });

  it('真 outbox 上按码分：23505、22P02、PGRST102、insert_conflict、没有码的 413 不算，quota、42501、25006 算（10.4b）', async () => {
    const { cache, outbox } = await setup();
    // 码为空串：只有状态（网关回的，没有 PostgREST 的 JSON 体），outbox 记 http_<状态>
    const codes: [number, string][] = [[409, '23505'], [400, '22P02'], [400, 'PGRST102'], [409, 'insert_conflict'], [413, ''], [400, 'quota'], [403, '42501'], [405, '25006']];
    for (let n = 1; n <= codes.length; n++) {
      await seed(cache, 'todos', uid(n), todo(n), 5);
      await outbox.enqueue({ table: 'todos', id: uid(n), op: 'patch', data: { title: `改${n}` }, remind: true });
    }
    for (let k = 0; k < codes.length; k++) {
      const it = await outbox.next();
      const n = codes.map((_, x) => x + 1).find((x) => uid(x) === it?.id) ?? 0;
      const [status, code] = codes[n - 1] ?? [400, 'x'];
      expect(await outbox.fail(it?.op_id ?? '', code ? { status, code, sid: null } : { status, sid: null })).toBe('permanent');
    }
    expect(outbox.getStatus().remindRecs.size).toBe(codes.length);
    expect((await outbox.list()).find((i) => i.id === uid(5))?.error).toBe('http_413');
    expect(outbox.getStatus().retryRecs).toEqual(new Set([6, 7, 8].map(rec)));
  });

  it('同一条记录：失败的那一项不带提醒、后面排着的一项带提醒 → 算；重试成功（回执）后移出', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '先改' } });
    const first = await outbox.next();   // 在途，后面那一项不会并进来
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '再改' }, remind: true });
    await outbox.fail(first?.op_id ?? '', { status: 409, code: '23503', sid: null });
    const items = await outbox.list();
    expect(items.find((i) => i.op_id === first?.op_id)).toMatchObject({ state: 'failed', remind: false });
    expect(items.some((i) => i.op_id !== first?.op_id && i.remind)).toBe(true);
    expect(outbox.getStatus().retryRecs).toEqual(new Set([rec(1)]));

    await outbox.retryFailed();
    for (;;) {
      const it = await outbox.next();
      if (!it) break;
      await outbox.ack(it.op_id, { status: 'ok', rev: 6, prev_rev: it.base_rev });
    }
    expect(outbox.getStatus().retryRecs.size).toBe(0);
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });
});
