// account export（10-31 QA 第四版核对后端补的函数单测）：
//   TC-B1-137 ① start 回应丢了用户再点一次：当天计数 +2、两个 export_id、两个任务互不相干；② 请求里带的 export_id 不用；
//   TC-B1-139 ② 伪造游标里的 b（改大）只影响本人那条 export_done 的 bytes，片数、数据、别人的导出照常。
// “客户端不自动重发 start”是前端的事（TC-B1-126 ⑤），不在这里。
import { describe, expect, it } from 'vitest';
import { CURSOR_MAX_B, keys } from '../../supabase/functions/account/core.ts';
import { A, B, accountSetup as setup, T0 } from './account-fakes.ts';
import { NEXT, part, runExport, start, uid } from './account-export-harness.ts';

const E1 = 'eeeeeeee-0000-4000-8000-0000000000e1';
const E2 = 'eeeeeeee-0000-4000-8000-0000000000e2';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 把游标（base64url 的 JSON）里的 b 换掉，其余原样 */
function withB(cursor: string, b: number): string {
  const o = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
  return btoa(JSON.stringify({ ...o, b })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 一片一片取到 done；forge 给了就在取第 lastIndex 片（从 0 数，最后一片）之前改游标。回各片字节 */
async function drain(db: Parameters<typeof part>[0], box: Parameters<typeof part>[1], exportId: string, over: Parameters<typeof part>[4], forge?: { lastIndex: number; f: (c: string) => string }) {
  const parts: Uint8Array[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    if (forge && i === forge.lastIndex && cursor !== null) cursor = forge.f(cursor);
    const r = await part(db, box, exportId, cursor, over);
    if (r.status !== 200) throw new Error(`part ${r.status} ${await r.text()}`);
    parts.push(new Uint8Array(await r.arrayBuffer()));
    const next = r.headers.get(NEXT) ?? '';
    if (next === 'done') return parts;
    cursor = next;
  }
  throw new Error('too_many_parts');
}

const doneOf = (db: ReturnType<typeof setup>['db'], u: string, code: string) =>
  db.logs.filter((l) => l.user_id === u && l.act === 'export_done' && l.code === code).map((l) => l.fields);

describe('TC-B1-137 ①②：start 不幂等、不收客户端给的 export_id', () => {
  it('① 第一次成功但回应丢了、用户再点一次：两次都扣（当天 +2），两个 export_id、两个任务行、两条 export 日志，各自取完互不相干', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [{ id: uid('11111111', 1), user_id: A, is_private: false, body: 'a-note' }]);
    const ids = [E1, E2];
    const over = { newId: () => ids.shift() ?? 'x' };
    const r1 = await start(db, box, {}, over);
    expect(r1.status).toBe(200);   // 回应“丢了”：客户端没读到，但服务器这边已经扣了、建了任务
    const r2 = await start(db, box, {}, over);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { export_id: string }).export_id).toBe(E2);
    expect(db.count(keys.account(A, T0))).toBe(2);
    expect(db.logs.filter((l) => l.act === 'export').map((l) => l.code)).toEqual([E1, E2]);
    // 两个任务各取各的：先把 E2 取完，E1 照样能从头取完；各记一条自己的 export_done
    const p2 = await drain(db, box, E2, {});
    const p1 = await drain(db, box, E1, {});
    expect(doneOf(db, A, E2)).toEqual([[`parts=${p2.length}`, `bytes=${p2.reduce((n, p) => n + p.byteLength, 0)}`]]);
    expect(doneOf(db, A, E1)).toEqual([[`parts=${p1.length}`, `bytes=${p1.reduce((n, p) => n + p.byteLength, 0)}`]]);
    expect(box).toHaveLength(2);   // 两次导出各发一封通知
  });

  it('② start 请求里带 export_id：不用这个值，回的是服务器自己生成的 uuid，任务键、logs 里都没有传入的值', async () => {
    const { db, box } = setup();
    const MINE = 'ffffffff-0000-4000-8000-0000000000ff';
    const r = await start(db, box, { export_id: MINE });   // 不注入 newId：走默认的 crypto.randomUUID
    expect(r.status).toBe(200);
    const { export_id: got } = (await r.json()) as { export_id: string };
    expect(got).toMatch(UUID4);
    expect(got).not.toBe(MINE);
    // 任务行按服务器的 id 建了：counters 里有这个键的行（count() 键不存在也回 0，不能拿它证明），用 got 取片成功
    const jobKey = keys.exportJob(A, got, 'omitted', 'aaaaaaaa-s1');
    expect([...db.counters.keys()].filter((k) => k.split('|')[0] === jobKey)).toHaveLength(1);
    expect([...db.counters.keys()].some((k) => k.includes(MINE))).toBe(false);
    expect(db.logs.some((l) => l.code === MINE)).toBe(false);
    expect(db.logs.filter((l) => l.act === 'export').map((l) => l.code)).toEqual([got]);
    expect((await part(db, box, got, null)).status).toBe(200);
    // 拿传入的值去取片：没有这个任务，410
    expect((await part(db, box, MINE, null)).status).toBe(410);
  });
});

describe('TC-B1-139 ②：伪造游标里的 b', () => {
  const over = { exportLimits: { partRawBytes: 1024 } };
  const seed = (db: ReturnType<typeof setup>['db']) => db.tables.set('notes', [
    ...Array.from({ length: 30 }, (_, i) => ({ id: uid('11111111', i + 1), user_id: A, is_private: false, body: `a-note-${i}-${'x'.repeat(80)}` })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: uid('11111111', i + 100), user_id: B, is_private: false, body: `b-note-${i}-${'y'.repeat(80)}` })),
  ]);

  it('最后一片前把 b 改大：只有本人这条 export_done 的 bytes 跟着变，片数、各片数据不变；同库另一个人的导出照常', async () => {
    // 对照组：老实取完
    const w0 = setup();
    seed(w0.db);
    const honest = await runExport(w0.db, w0.box, { ...over, newId: () => E1 });
    expect(honest.parts.length).toBeGreaterThan(2);
    const honestBytes = honest.parts.reduce((n, p) => n + p.byteLength, 0);

    const { db, box } = setup();
    seed(db);
    const s = await start(db, box, {}, { ...over, newId: () => E1 });
    expect(s.status).toBe(200);
    const BUMP = 1_000_000;
    let forged = false;
    const parts = await drain(db, box, E1, over, { lastIndex: honest.parts.length - 1, f: (c) => {
      forged = true;
      const o = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))) as { b: number };
      return withB(c, o.b + BUMP);
    } });
    expect(forged).toBe(true);
    // 各片字节、片数和老实取的一样（b 不参与取数）
    expect(parts.map((p) => Array.from(p).join(','))).toEqual(honest.parts.map((p) => Array.from(p).join(',')));
    // export_done：parts 和老实取的一样（取自任务行），bytes 只多了伪造的那一截
    expect(doneOf(db, A, E1)).toEqual([[`parts=${honest.parts.length}`, `bytes=${honestBytes + BUMP}`]]);
    expect(doneOf(w0.db, A, E1)).toEqual([[`parts=${honest.parts.length}`, `bytes=${honestBytes}`]]);

    // 同一个库里 B 的导出：自己的 export_done 字节照实
    const runB = await runExport(db, box, { ...over, user: B, newId: () => E2 });
    expect(doneOf(db, B, E2)).toEqual([[`parts=${runB.parts.length}`, `bytes=${runB.parts.reduce((n, p) => n + p.byteLength, 0)}`]]);
    expect(JSON.stringify(runB.doc)).not.toContain('a-note');
  });

  it('b 超过上限（2^40）或不是非负整数：游标不对，400，不写 export_done', async () => {
    const { db, box } = setup();
    seed(db);
    expect((await start(db, box, {}, { ...over, newId: () => E1 })).status).toBe(200);
    const first = await part(db, box, E1, null, over);
    const next = first.headers.get(NEXT) ?? '';
    expect(next).not.toBe('done');
    for (const b of [CURSOR_MAX_B + 1, -1, 1.5]) {
      expect((await part(db, box, E1, withB(next, b), over)).status).toBe(400);
    }
    expect(doneOf(db, A, E1)).toEqual([]);
  });
});
