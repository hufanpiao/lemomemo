// account 函数 export 的单元测试之二：part 一步（架构 0.47 续 ①“取一片”“响应”，S2、M3；TC-B1-67 的函数一半）。
//   各片拼起来整份解开、只有本人的行、隐私记、文件头和 start 回的时刻一致、export_done、响应头、会话和模式对不上 410、数据导致的失败。
//   每片预算、翻页大小、上限和游标在 account-export-limits.test.ts。
import { describe, expect, it } from 'vitest';
import { EXPORT_MAX_LOG_ROWS, EXPORT_MAX_ROWS, keys } from '../../supabase/functions/account/core.ts';
import { A, accountSetup as setup, B, H, T0 } from './account-fakes.ts';
import { gunzip, NEXT, part, runExport, start, TABLES, tablesOf, uid } from './account-export-harness.ts';

const N1 = uid('11111111', 1);
const N2 = uid('11111111', 2);
const N3 = uid('11111111', 3);

async function startId(db: Parameters<typeof start>[0], box: Parameters<typeof start>[1], headers: Record<string, string> = {}, over: Parameters<typeof start>[3] = {}) {
  const r = await start(db, box, {}, over, headers);
  return ((await r.json()) as { export_id: string }).export_id;
}

describe('account export part：拼起来是一份完整的导出', () => {
  it('TC-B1-67：没带令牌 vault = omitted、包里没有隐私记行、只有本人的行；文件头 exported_at = start 回的；logs 一条 export、一条 export_done', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [
      { id: N1, user_id: A, is_private: false, body: 'a-note' },
      { id: N2, user_id: A, is_private: true, body_enc: 'C' },
      { id: N3, user_id: B, is_private: false, body: 'b-note' },
    ]);
    db.tables.set('note_images', [{ id: uid('22222222', 1), user_id: A, bucket: 'vault-images' }, { id: uid('22222222', 2), user_id: A, bucket: 'images' }]);
    const run = await runExport(db, box);
    expect(run.doc).toMatchObject({ format: 'lemomemo-export', version: 1, user_id: A, vault: 'omitted', exported_at: run.exportedAt });
    const tables = tablesOf(run.doc);
    expect(Object.keys(tables)).toEqual(TABLES.map((t) => t.name));
    expect(tables.notes?.map((n) => n.id)).toEqual([N1]);
    expect(tables.note_images?.map((n) => n.id)).toEqual([uid('22222222', 2)]);
    expect(Object.values(tables).flat().every((row) => row.user_id === A)).toBe(true);
    expect(JSON.stringify(run.doc)).not.toMatch(/b-note|"C"/);
    // logs：export 那一条在包里（start 时写的）；export_done 在最后一片之后写，code 相同，片数和字节数对得上
    expect(tables.logs?.map((l) => l.act)).toEqual(['export']);
    const done = db.logs.filter((l) => l.act === 'export_done');
    expect(done).toEqual([expect.objectContaining({ code: run.exportId, fields: [`parts=${run.parts.length}`, `bytes=${run.parts.reduce((n, p) => n + p.byteLength, 0)}`] })]);
    expect(db.logs.find((l) => l.act === 'export')?.code).toBe(run.exportId);
    // 任务行 count = 实际片数；当天 account 只扣 1 次，export-part 扣的 = part 调用数
    expect(db.count(keys.account(A, T0))).toBe(1);
    expect(db.count(keys.exportPart(A, T0))).toBe(run.parts.length);
    expect(box).toHaveLength(1);
  });

  it('响应（S2）：application/gzip、no-store、nosniff，没有 Content-Encoding；每片是单独的 gzip 成员；下一个游标在 x-lemo-export-next', async () => {
    const { db, box } = setup();
    const id = await startId(db, box);
    const r = await part(db, box, id, null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/gzip');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-encoding')).toBeNull();
    expect(r.headers.get(NEXT)).toBe('done');   // 数据少，一片就完
    const b = new Uint8Array(await r.arrayBuffer());
    expect([b[0], b[1]]).toEqual([0x1f, 0x8b]);
    expect(JSON.parse(await gunzip(b))).toMatchObject({ format: 'lemomemo-export' });
  });

  it('带了有效令牌：vault = cipher，隐私记行只有密文列；part 没带令牌（模式对不上）回 410', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [{ id: N2, user_id: A, is_private: true, body: 'plain-should-not-leak', body_enc: 'C' }]);
    const over = { verifyVaultToken: async (u: string, t: string) => (u === A && t === 'tok' ? ('ok' as const) : ('vault_locked' as const)) };
    const run = await runExport(db, box, over, { 'x-vault-token': 'tok' });
    expect(run.doc.vault).toBe('cipher');
    expect(JSON.stringify(run.doc)).not.toContain('plain-should-not-leak');
    const id = await startId(db, box, { 'x-vault-token': 'tok' }, over);
    expect(await (await part(db, box, id, null, over)).json()).toEqual({ error: 'export_expired' });
    // part 带了无效令牌：vault_locked
    expect(await (await part(db, box, id, null, over, { 'x-vault-token': 'bad' })).json()).toEqual({ error: 'vault_locked' });
  });

  it('M3：别的会话、别的用户拿同一个 export_id 都是 410；开始满 1 小时 410；不存在的 export_id 410', async () => {
    const { db, box, clock } = setup();
    const id = await startId(db, box);
    expect((await part(db, box, id, null, { session: 'aaaaaaaa-s2' })).status).toBe(410);
    expect((await part(db, box, id, null, { user: B })).status).toBe(410);
    expect((await part(db, box, uid('99999999', 1), null)).status).toBe(410);
    clock.advance(H - 1000);
    expect((await part(db, box, id, null)).status).toBe(200);
    clock.advance(1000);
    const gone = await part(db, box, id, null);
    expect(gone.headers.get('cache-control')).toBe('no-store');   // TC-B1-130 ④：错误回包也不进任何缓存
    expect(await gone.json()).toEqual({ error: 'export_expired' });
  });

  it('同一个游标重试得到同样的字节和同样的下一个游标（数据没变时；不是最后一片，所以中间没写 export_done）', async () => {
    const { db, box } = setup();
    db.tables.set('todos', Array.from({ length: 300 }, (_, i) => ({ id: uid('33333333', i), user_id: A, title: `t${i}` })));
    const over = { exportLimits: { partRawBytes: 2048 } };
    const id = await startId(db, box, {}, over);
    const r1 = await part(db, box, id, null, over);
    const r2 = await part(db, box, id, null, over);
    expect(r1.headers.get(NEXT)).not.toBe('done');
    expect(r2.headers.get(NEXT)).toBe(r1.headers.get(NEXT));
    const a = new Uint8Array(await r1.arrayBuffer());
    const b = new Uint8Array(await r2.arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('logs 超过 25,000 行照样导出（logs 上限另算）；devices 不导出推送订阅的密钥和会话 id（exportOmitCols）', async () => {
    const { db, box } = setup();
    for (let i = 0; i < 30_000; i++) db.logs.push({ id: 1_000_000 + i, user_id: A, act: 'x', device: null, t: i });
    db.tables.set('devices', [{
      id: 'dddddddd-0000-4000-8000-000000000001', user_id: A, label: '我的 iPhone', platform: 'ios',
      push_endpoint: 'https://push.example/abc', p256dh: 'P256', auth: 'AUTHKEY', session_id: 'eeeeeeee-0000-4000-8000-000000000001',
    }]);
    const run = await runExport(db, box);
    const tables = tablesOf(run.doc);
    expect(tables.logs).toHaveLength(30_001);   // 加上 start 写的那一条
    expect(EXPORT_MAX_LOG_ROWS).toBeGreaterThanOrEqual(2000 * 90);
    expect(TABLES.find((t) => t.name === 'logs')?.maxRows).toBe(EXPORT_MAX_LOG_ROWS);
    expect(TABLES.find((t) => t.name === 'todos')?.maxRows).toBe(EXPORT_MAX_ROWS);
    expect(tables.devices?.[0]).toMatchObject({ label: '我的 iPhone', platform: 'ios' });
    expect(JSON.stringify(run.doc)).not.toMatch(/AUTHKEY|P256|push\.example|eeeeeeee/);
  });

  it('最后一个游标重复请求（回应丢了重试）：照样回最后一片，export_done 只有一条（代码审查 E1）；查不了就照写', async () => {
    const { db, box } = setup();
    db.tables.set('todos', Array.from({ length: 300 }, (_, i) => ({ id: uid('33333333', i), user_id: A, title: `t${i}` })));
    const over = { exportLimits: { partRawBytes: 2048 } };
    const id = await startId(db, box, {}, over);
    let cursor: string | null = null;
    let last: string | null = null;
    for (let i = 0; i < 100; i++) {
      const next: string | null = (await part(db, box, id, cursor, over)).headers.get(NEXT);
      if (next === 'done') { last = cursor; break; }
      cursor = next;
    }
    const again = await part(db, box, id, last, over);
    expect(again.status).toBe(200);
    expect(again.headers.get(NEXT)).toBe('done');
    expect(db.logs.filter((l) => l.act === 'export_done')).toHaveLength(1);
    db.fail.add('exportDoneLogged');
    const logs: string[] = [];
    expect((await part(db, box, id, last, { ...over, log: (c) => logs.push(c) })).status).toBe(200);
    expect(logs).toEqual(['export_done_check_failed']);
    expect(db.logs.filter((l) => l.act === 'export_done')).toHaveLength(2);
  });

  it('export_done 写不进只记错误码，最后一片照常回', async () => {
    const { db, box } = setup();
    db.fail.add('insertLog:export_done');
    const logs: string[] = [];
    const id = await startId(db, box);
    const r = await part(db, box, id, null, { log: (c) => logs.push(c) });
    expect(r.status).toBe(200);
    expect(r.headers.get(NEXT)).toBe('done');
    expect(logs).toEqual(['export_done_log_failed']);
  });
});

describe('account export part：数据导致的失败只记 export_<码>、回 try_later', () => {
  it('读到别人的行（service role 绕过 RLS，条件写错时）：try_later，记 export_foreign_row', async () => {
    const { db, box } = setup();
    const id = await startId(db, box);
    const store = db.accountStore();
    const logs: string[] = [];
    const r = await part(db, box, id, null, {
      log: (c) => logs.push(c), store: { ...store, readPage: async (t) => (t === 'settings' ? [{ id: uid('44444444', 1), user_id: B }] : []) },
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(logs).toEqual(['export_foreign_row']);
  });

  it('超过表的行数上限：export_too_many_rows；主键不前进（重复、类型不对）：export_bad_page_key', async () => {
    const { db, box } = setup();
    db.tables.set('todos', Array.from({ length: 30 }, (_, i) => ({ id: uid('33333333', i), user_id: A })));
    const logs: string[] = [];
    const small = TABLES.map((t) => (t.name === 'todos' ? { ...t, maxRows: 20 } : t));
    let id = await startId(db, box);
    expect((await part(db, box, id, null, { exportTables: small, log: (c) => logs.push(c) })).status).toBe(503);
    const store = db.accountStore();
    for (const bad of [[{ id: 'not-a-uuid', user_id: A }], [{ id: uid('33333333', 1), user_id: A }, { id: uid('33333333', 1), user_id: A }]]) {
      id = await startId(db, box);
      const r = await part(db, box, id, null, { log: (c) => logs.push(c), store: { ...store, readPage: async (t) => (t === 'todos' ? bad : []) } });
      expect(r.status).toBe(503);
    }
    expect(logs).toEqual(['export_too_many_rows', 'export_bad_page_key', 'export_bad_page_key']);
  });

  it('数据库出错：try_later（core 记 db_error），不退 export-part', async () => {
    const { db, box } = setup();
    const id = await startId(db, box);
    db.fail.add('readPage');
    const logs: string[] = [];
    expect((await part(db, box, id, null, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs).toEqual(['db_error']);
    expect(db.count(keys.exportPart(A, T0))).toBe(1);
  });
});
