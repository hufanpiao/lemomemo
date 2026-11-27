// account 函数 export 的单元测试之三：part 的上限和游标（架构 0.47 续 ①“取一片”“游标”“常量”，0.47 第 14、18、19 条；安全审查 M2、S1、Q3、Q5）。
//   每写一行查一次预算（单片原文 ≤ 预算 + 一行）、第一页 50 行和按行宽自适应、r 跨片带着走、分片上限 413、每天分片数 429（坏游标也算）、
//   游标逐项校验、跨域暴露游标头。迁移里预检函数的表清单和数据清单比对在 tests/build/export-size-tables.test.ts（要读文件）。
import { describe, expect, it } from 'vitest';
import {
  CURSOR_MAX_B, CURSOR_MAX_R, decodeCursor, encodeCursor, EXPORT_LIMITS, type ExportCursor, type ExportTable, keyOk, keys, pageSize,
} from '../../supabase/functions/account/core.ts';
import { EXPOSE_HEADERS } from '../../functions/_lib/cors.ts';
import { A, accountSetup as setup, T0 } from './account-fakes.ts';
import { call, NEXT, part, runExport, start, TABLES, tablesOf, uid } from './account-export-harness.ts';

const todos = (n: number, width: number) => Array.from({ length: n }, (_, i) => ({ id: uid('33333333', i), user_id: A, title: 'x'.repeat(width) }));
const reads = (db: ReturnType<typeof setup>['db'], t: string) => db.pageReads.filter((p) => p.table === t);

describe('account export part：每片预算和翻页（0.47 第 18、19 条，主持人：单片原文不超过预算 + 一行）', () => {
  it('每写一行查一次预算：每一片的原文都不超过“预算 + 一行”，拼起来和一片取完的结果一字不差', async () => {
    const budget = 4096;
    const w1 = setup();
    w1.db.tables.set('todos', todos(200, 280));
    const small = await runExport(w1.db, w1.box, { exportLimits: { partRawBytes: budget }, newId: () => uid('eeeeeeee', 1) });
    const oneRow = Math.max(...(tablesOf(small.doc).todos ?? []).map((r) => JSON.stringify(r).length)) + 1;   // 加前面的逗号
    expect(small.parts.length).toBeGreaterThan(10);
    for (const raw of small.raws) expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(budget + oneRow);
    // 除了最后一片，每片都至少到了预算（不会白白多切）
    for (const raw of small.raws.slice(0, -1)) expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThanOrEqual(budget);
    const w2 = setup();
    w2.db.tables.set('todos', todos(200, 280));
    const big = await runExport(w2.db, w2.box, { newId: () => uid('eeeeeeee', 1) });
    expect(big.parts).toHaveLength(1);
    expect(small.raws.join('')).toBe(big.raws[0]);
    expect(tablesOf(small.doc).todos).toHaveLength(200);
  });

  it('一行就超预算的胖行：每片正好一行，照样取完', async () => {
    const { db, box } = setup();
    db.tables.set('todos', todos(5, 3000));
    const run = await runExport(db, box, { exportLimits: { partRawBytes: 1000 } });
    expect(tablesOf(run.doc).todos).toHaveLength(5);
    expect(run.raws.filter((r) => r.includes('x'.repeat(3000))).every((r) => r.split('x'.repeat(3000)).length === 2)).toBe(true);
  });

  it('翻页（Q5）：每张表第一页 50 行，之后 250 行；按主键往后翻（gt 上一页最后一个 id），不用 offset', async () => {
    const { db, box } = setup();
    const rows = todos(600, 10);
    db.tables.set('todos', rows);
    const run = await runExport(db, box);
    expect(tablesOf(run.doc).todos?.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(reads(db, 'todos').map((p) => [p.limit, p.after])).toEqual([[50, null], [250, rows[49]?.id], [250, rows[299]?.id], [250, rows[549]?.id]]);
    expect(reads(db, 'settings').map((p) => p.limit)).toEqual([50]);
  });

  it('胖行（平均每行超过 8 KB）：下一页按 2 MB ÷ 平均行宽取，至少 10 行', async () => {
    const { db, box } = setup();
    db.tables.set('todos', todos(200, 20_000));
    await runExport(db, box);
    const avg = JSON.stringify({ id: uid('33333333', 0), user_id: A, title: 'x'.repeat(20_000) }).length;
    const want = Math.floor((2 * 1024 * 1024) / avg);
    expect(reads(db, 'todos').map((p) => p.limit)).toEqual([50, want, want]);
    expect(pageSize(200_000, EXPORT_LIMITS)).toBe(10);
    expect(pageSize(8 * 1024, EXPORT_LIMITS)).toBe(250);
    expect(pageSize(undefined, EXPORT_LIMITS)).toBe(50);
  });

  it('平均行宽 r 记进游标、跨片带着走：下一片接着读的第一页按 r 取，不再是 50 行；换表清空', async () => {
    const { db, box } = setup();
    db.tables.set('todos', todos(40, 20_000));
    const run = await runExport(db, box, { exportLimits: { partRawBytes: 100_000 } });
    const curs = run.cursors.filter((c) => c !== 'done').map((c) => JSON.parse(Buffer.from(c, 'base64url').toString()) as ExportCursor);
    const inTodos = curs.filter((c) => TABLES[c.t]?.name === 'todos' && c.after !== null);
    expect(inTodos.length).toBeGreaterThan(2);
    for (const c of inTodos) expect(c.r).toBeGreaterThan(20_000);
    expect(reads(db, 'todos').map((p) => p.limit).slice(1).every((l) => l === Math.floor((2 * 1024 * 1024) / (inTodos[0]?.r ?? 1)))).toBe(true);
    expect(curs.filter((c) => c.after === null).every((c) => c.r === undefined)).toBe(true);
  });
});

describe('account export part：两个上限（M2）', () => {
  it('一个任务最多 EXPORT_MAX_PARTS 片：超了回 413 export_too_large（超的这次也算）', async () => {
    const { db, box } = setup();
    db.tables.set('todos', todos(100, 280));
    const over = { exportLimits: { partRawBytes: 1024, maxParts: 2 } };
    const id = ((await (await start(db, box, {}, over)).json()) as { export_id: string }).export_id;
    let cursor: string | null = null;
    for (let i = 0; i < 2; i++) {
      const r = await part(db, box, id, cursor, over);
      expect(r.status).toBe(200);
      cursor = r.headers.get(NEXT);
    }
    const r = await part(db, box, id, cursor, over);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'export_too_large' });
    expect(EXPORT_LIMITS).toMatchObject({ partRawBytes: 16 * 1024 * 1024, maxParts: 36, partDailyLimit: 72, maxTotalRawBytes: 480 * 1024 * 1024 });
  });

  it('每人每天分片总数：先扣再看游标，坏游标、410 也算；超了 429', async () => {
    const { db, box } = setup();
    const over = { exportLimits: { partDailyLimit: 3 } };
    const id = ((await (await start(db, box)).json()) as { export_id: string }).export_id;
    expect((await part(db, box, id, 'bad!', over)).status).toBe(400);
    expect((await part(db, box, uid('99999999', 9), null, over)).status).toBe(410);
    expect((await part(db, box, id, null, over)).status).toBe(200);
    const r = await part(db, box, id, null, over);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.count(keys.exportPart(A, T0))).toBe(4);
  });
});

describe('account export part：游标（S1，不透明、逐项校验、≤ 512 字节）', () => {
  const todosT = TABLES.findIndex((t) => t.name === 'todos');
  const logsT = TABLES.findIndex((t) => t.name === 'logs');
  const profT = TABLES.findIndex((t) => t.name === 'profiles');
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ok = { t: todosT, after: uid('33333333', 1), n: 3, w: true, b: 100 };

  it('合法的游标原样解出来；最大的游标也不超过 512 字节', () => {
    expect(decodeCursor(null, TABLES, A, 512)).toBeNull();
    expect(decodeCursor(encodeCursor(ok), TABLES, A, 512)).toEqual({ ...ok, r: undefined });
    expect(decodeCursor(enc({ t: logsT, after: 12, n: 0, w: false, b: 0, r: 9 }), TABLES, A, 512)).toEqual({ t: logsT, after: 12, n: 0, w: false, b: 0, r: 9 });
    expect(decodeCursor(enc({ t: profT, after: A, n: 1, w: true, b: 0 }), TABLES, A, 512)).toMatchObject({ after: A });
    const biggest = encodeCursor({ t: TABLES.length - 1, after: uid('ffffffff', 2 ** 40), n: 200_000, w: true, b: CURSOR_MAX_B, r: CURSOR_MAX_R });
    expect(biggest.length).toBeLessThanOrEqual(EXPORT_LIMITS.cursorMaxBytes);
  });

  it('不对的一律 undefined（回 bad_request）', () => {
    const maxRows = TABLES[todosT]?.maxRows ?? 0;
    for (const [why, raw] of [
      ['不是字符串', 123], ['空串', ''], ['不是 base64url', 'a+b/c='], ['太长', 'A'.repeat(513)], ['不是 JSON', Buffer.from('{x').toString('base64url')],
      ['数组', enc([1])], ['多一个字段', enc({ ...ok, x: 1 })], ['t 越界', enc({ ...ok, t: TABLES.length })], ['t 负数', enc({ ...ok, t: -1 })],
      ['t 小数', enc({ ...ok, t: 1.5 })], ['uuid 表给了数字', enc({ ...ok, after: 5 })], ['uuid 表给了别的串', enc({ ...ok, after: "x' or 1=1" })],
      ['整数表给了串', enc({ t: logsT, after: '5', n: 0, w: false, b: 0 })], ['整数表给了小数', enc({ t: logsT, after: 5.5, n: 0, w: false, b: 0 })],
      ['profiles 给了别人', enc({ t: profT, after: uid('bbbbbbbb', 2), n: 1, w: true, b: 0 })], ['n 超表上限', enc({ ...ok, n: maxRows + 1 })],
      ['n 负数', enc({ ...ok, n: -1 })], ['w 不是布尔', enc({ ...ok, w: 1 })], ['b 超 2^40', enc({ ...ok, b: CURSOR_MAX_B + 1 })],
      ['r 超 2^20', enc({ ...ok, r: CURSOR_MAX_R + 1 })], ['r 是串', enc({ ...ok, r: '9' })], ['缺 b', enc({ t: todosT, after: null, n: 0, w: false })],
    ] as const) expect(decodeCursor(raw, TABLES, A, 512), why).toBeUndefined();
  });

  it('文本主键只收 ^[a-z0-9._-]{1,64}$（现在没有这种表，留给以后）', () => {
    const t: ExportTable = { name: 'x', keyCol: 'id', keyType: 'text', maxRows: 1, omitCols: [] };
    expect(keyOk(t, 'theme.dark', A)).toBe(true);
    for (const bad of ['', 'A', 'a,b', 'a)', 'x'.repeat(65), 5]) expect(keyOk(t, bad, A), String(bad)).toBe(false);
  });

  it('坏游标、坏 export_id、没带 cursor：400 bad_request', async () => {
    const { db, box } = setup();
    const id = ((await (await start(db, box)).json()) as { export_id: string }).export_id;
    expect((await part(db, box, id, enc({ ...ok, t: 99 }))).status).toBe(400);
    expect((await part(db, box, 'not-a-uuid', null)).status).toBe(400);
    const r = await call(db, box, { action: 'export', step: 'part', export_id: id });
    expect(r.status).toBe(400);
  });

  it('游标头在电脑版跨域时也读得到：functions/_lib/cors.ts 的 EXPOSE_HEADERS 有 x-lemo-export-next', () => {
    expect(EXPOSE_HEADERS).toContain(NEXT);
  });
});
