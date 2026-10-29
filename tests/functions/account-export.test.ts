// account 函数 export 一组的单元测试（从 account.test.ts 拆出，ACCOUNT-sugg ①）：TC-B1-67 的函数一半，
//   回 gzip 的 JSON、不发下载链接、只有本人的行、隐私记、分页、上限、退回次数、导出通知里的设备名。只测 core.ts（经它转出的 export.ts）。
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DAILY_LIMIT, cleanDeviceLabel, EXPORT_MAX_LOG_ROWS, EXPORT_MAX_ROWS, EXPORT_PAGE, exportRows, exportTablesOf, handle, isVaultRow, keys,
} from '../../supabase/functions/account/core.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { A, accountDeps, accountReq, B, accountSetup as setup, callAccount as call, COUNTER_KEY, type FakeDb, type Outbox, T0 } from './account-fakes.ts';

describe('account export（TC-B1-67：回 gzip 的 JSON、不发下载链接、只有本人的行、第 4 次被拒）', () => {
  const TABLES = exportTablesOf(allManifests);

  it('按清单挑表：只要 public、export = json 的；private 的表、vault 系列、向量一律不在', () => {
    const names = TABLES.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(['profiles', 'settings', 'devices', 'events', 'todos', 'notes', 'note_images', 'note_files', 'anniversaries']));
    for (const no of ['vault', 'vault_credentials', 'device_secrets', 'note_vectors', 'embed_queue', 'vault_preview', 'vault_ai', 'counters', 'tombstones', 'app_config', 'pending_deletions']) {
      expect(names, no).not.toContain(no);
    }
    expect(TABLES.filter((t) => t.vaultRows).map((t) => t.name).sort()).toEqual(['note_files', 'note_images', 'notes']);
  });

  it('隐私记行的判断：列名写法和 "col = \'value\'" 写法都认；认不出的写法报错', () => {
    expect(isVaultRow({ is_private: true }, 'is_private')).toBe(true);
    expect(isVaultRow({ is_private: false }, 'is_private')).toBe(false);
    expect(isVaultRow({ bucket: 'vault-images' }, "bucket = 'vault-images'")).toBe(true);
    expect(isVaultRow({ bucket: 'images' }, "bucket = 'vault-images'")).toBe(false);
    expect(() => isVaultRow({}, 'is_private or true')).toThrow('bad_vault_flag');
  });

  it('不带令牌：隐私记行整行不要；带有效令牌：隐私记行只留密文列和不含内容的列', () => {
    const notes = TABLES.find((t) => t.name === 'notes');
    if (!notes?.vaultRows) throw new Error('notes 没有 vaultRows');
    const plainCol = Object.keys({ body: 1, title: 1 }).find((c) => !notes.vaultRows?.cipherCols.includes(c) && !notes.vaultRows?.neutralCols.includes(c)) ?? 'body';
    const rows = [
      { id: '1', user_id: A, is_private: false, [plainCol]: 'hello' },
      { id: '2', user_id: A, is_private: true, [plainCol]: 'secret', ...Object.fromEntries(notes.vaultRows.cipherCols.map((c) => [c, 'CIPHER'])) },
    ];
    expect(exportRows(notes, rows, 'omitted').map((r) => r.id)).toEqual(['1']);
    const withVault = exportRows(notes, rows, 'cipher');
    expect(withVault).toHaveLength(2);
    expect(withVault[1]).not.toHaveProperty(plainCol);
    for (const c of notes.vaultRows.cipherCols) expect(withVault[1]).toHaveProperty(c, 'CIPHER');
  });

  async function exportOnce(db: FakeDb, box: Outbox[], body: Record<string, unknown> = {}, headers: Record<string, string> = {}, over: Parameters<typeof accountDeps>[2] = {}) {
    const r = await call(db, box, { action: 'export', ...body }, { exportTables: TABLES, ...over }, headers);
    return r;
  }

  async function unzip(r: Response): Promise<Record<string, unknown>> {
    const s = r.body?.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(s).text()) as Record<string, unknown>;
  }

  it('TC-B1-67：回 gzip 的 JSON：attachment、no-store；先记 logs 再导出；没带令牌 vault = omitted、包里没有任何隐私记行；只有本人的行', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [
      { id: 'n1', user_id: A, is_private: false, body: 'a-note' },
      { id: 'n2', user_id: A, is_private: true, body_enc: 'C' },
      { id: 'n3', user_id: B, is_private: false, body: 'b-note' },
    ]);
    db.tables.set('note_images', [{ id: 'i1', user_id: A, bucket: 'vault-images' }, { id: 'i2', user_id: A, bucket: 'images' }]);
    db.devices.set('dddddddd-0000-4000-8000-000000000001', { user_id: A, label: '我的 iPhone' });
    const r = await exportOnce(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000001' },
      { 'x-proxy-secret': 'proxy-secret', 'x-lemo-geo': `KR|${encodeURIComponent('서울')}` });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/gzip');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="lemomemo-export-20261029.json.gz"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const doc = await unzip(r);
    expect(doc).toMatchObject({ format: 'lemomemo-export', version: 1, user_id: A, vault: 'omitted' });
    const tables = doc.tables as Record<string, { id?: string; user_id?: string }[]>;
    expect(tables.notes?.map((n) => n.id)).toEqual(['n1']);
    expect(tables.note_images?.map((n) => n.id)).toEqual(['i2']);
    expect(Object.values(tables).flat().every((row) => row.user_id === A)).toBe(true);
    expect(JSON.stringify(doc)).not.toMatch(/pin_hash|secret|b-note/);
    // 先记录：导出前写的那条 export 日志就在包里
    expect(db.logs.map((l) => l.act)).toEqual(['export']);
    expect(db.logs[0]?.device).toBe('dddddddd-0000-4000-8000-000000000001');
    // 通知邮件只写时间、设备名、地区
    expect(box).toHaveLength(1);
    expect(box[0]?.mail.text).toContain('我的 iPhone');
    expect(box[0]?.mail.text).toContain('KR 서울');
    expect(box[0]?.mail.text).toContain('2026年10月29日 12:00（Asia/Seoul）');
    expect(box[0]?.mail.text).not.toMatch(/http|n1|a-note/);
  });

  it('logs 写不进：回 try_later、不导出、不发信', async () => {
    const { db, box } = setup();
    db.fail.add('insertLog:export');
    const r = await exportOnce(db, box);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(box).toEqual([]);
  });

  it('发信失败不当作“没导出”：照样回文件，另记一条 export_mail_failed', async () => {
    const { db, box } = setup();
    const r = await exportOnce(db, box, {}, {}, { sendMail: async () => false });
    expect(r.status).toBe(200);
    expect(db.logs.map((l) => l.act)).toEqual(['export', 'export_mail_failed']);
    // 配对：export_mail_failed 的 code = export 那一行 t 的 ISO 字符串（logs.code ≤ 64）
    expect(db.logs[1]?.code).toBe(new Date(db.logs[0]?.t ?? 0).toISOString());
    expect(db.logs[0]?.code).toBeUndefined();
  });

  it('同一台设备连着导出两次、两封信都没发出去，晚的先失败：两条 export_mail_failed 各自配得上自己那次导出（code = export 的 t）', async () => {
    const { db, box, clock } = setup();
    const dev = 'dddddddd-0000-4000-8000-000000000001';
    const gates: ((ok: boolean) => void)[] = [];
    const deps = accountDeps(db, box, { exportTables: TABLES, sendMail: () => new Promise<boolean>((res) => { gates.push(res); }) });
    expect((await handle(accountReq({ action: 'export', device_id: dev }), deps)).status).toBe(200);
    clock.advance(1000);
    expect((await handle(accountReq({ action: 'export', device_id: dev }), deps)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));   // 两次的发信都卡在 sendMail
    expect(gates).toHaveLength(2);
    clock.advance(2000);
    gates[1]?.(false);   // 第二次先失败
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(1000);
    gates[0]?.(false);
    await Promise.all(deps.bg);
    const exports = db.logs.filter((l) => l.act === 'export');
    const fails = db.logs.filter((l) => l.act === 'export_mail_failed');
    expect(exports.map((l) => l.t)).toEqual([T0, T0 + 1000]);
    expect(fails.map((l) => l.t)).toEqual([T0 + 3000, T0 + 4000]);   // t 照旧是失败时刻
    expect(fails.map((l) => l.code)).toEqual([new Date(T0 + 1000).toISOString(), new Date(T0).toISOString()]);
    for (const f of fails) {
      expect(f.code?.length).toBeLessThanOrEqual(64);
      expect(exports.filter((e) => e.device === f.device && new Date(e.t).toISOString() === f.code)).toHaveLength(1);
    }
  });

  it('设备查不到写“未知设备”；没经转发层（头不可信）写“未知地区”；像链接的设备名不用', async () => {
    const { db, box } = setup();
    db.devices.set('dddddddd-0000-4000-8000-000000000002', { user_id: A, label: 'http://evil.example' });
    await exportOnce(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000002' }, { 'x-lemo-geo': 'KR|Seoul' });
    expect(box[0]?.mail.text).toContain('设备：未知设备');
    expect(box[0]?.mail.text).toContain('地区：未知地区');
    expect(box[0]?.mail.text).not.toMatch(/http|evil/);
    expect(cleanDeviceLabel('Galaxy S26')).toBe('Galaxy S26');
    expect(cleanDeviceLabel('a.example.com/x')).toBeNull();
  });

  it('设备名过滤（K3 安全审查必改 1）：像域名、网址、邮箱的整个不用，全角、句号、零宽、方向控制符都绕不过去', () => {
    for (const bad of [
      '访问 evil.com 领取', 'lemo-verify.co 验证', 'ｅｖｉｌ．ｃｏｍ', 'evil。com', 'evil｡com', 'EVIL.COM 客服',
      'ev\u200bil.com', 'evil\u200d.\u200dcom', '\u202emoc.live', '\u2066evil.com\u2069', 'evil . com',
      'support@lemo', 'a://b', 'ｈｔｔｐｓ：／／x', 'www 点 x', 'hxxp://evil', '联系 kefu＠evil',
      // K3 复审 A：非拉丁顶级域、IP、混写字母（evil.cоm 的 о 是西里尔字母）
      '示例.中国 验证', 'lemo.公司', '레모.한국', 'пример.рф', 'evil.рф', '192.168.10.5', 'evil.c' + '\u043e' + 'm',
      // 任何点或句号都不放：半角点、句号、全角点、半角句号
      'iPhone 15.2', '小王。手机', 'a．b', 'a｡b',
      // K3 复审低 1：像电话号码的（7 位以上数字，中间隔空白、横线、括号等）
      '客服 02-1234-5678', '回拨 010 1234 5678', '０１０１２３４５６７８', '(02) 123-4567', '+82 10 1234 5678', '1234567', '010—1234—5678',
    ]) expect(cleanDeviceLabel(bad), JSON.stringify(bad)).toBeNull();
    for (const ok of ['iPhone 15 Pro', 'Galaxy S24', 'Galaxy S24 Ultra 512GB', 'Pixel 9 Pro XL', 'iPad Air 2024', '123456 号机']) {
      expect(cleanDeviceLabel(ok), ok).toBe(ok);
    }
    // 正常名字照常用；NFKC 把全角字母变半角；控制、零宽、方向控制符去掉
    expect(cleanDeviceLabel('我的 iPhone')).toBe('我的 iPhone');
    expect(cleanDeviceLabel('ｉＰａｄ Pro 13')).toBe('iPad Pro 13');
    expect(cleanDeviceLabel('Pixel\u200b 9\u202e')).toBe('Pixel 9');
    expect(cleanDeviceLabel('a\u0000b\u0085c')).toBe('a b c');
    expect(cleanDeviceLabel('\u200b\u200b')).toBeNull();
    expect(cleanDeviceLabel('长'.repeat(60))).toBe('长'.repeat(40));
  });

  it('邮件里用的就是过滤后的名字：钓鱼写法的设备名写成“未知设备”', async () => {
    for (const label of ['访问 evil.com 领取', 'ｅｖｉｌ．ｃｏｍ', 'evil。com']) {
      const { db, box } = setup();
      db.devices.set('dddddddd-0000-4000-8000-000000000009', { user_id: A, label });
      await exportOnce(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000009' });
      expect(box[0]?.mail.text, label).toContain('设备：未知设备');
      expect(box[0]?.mail.text, label).not.toMatch(/evil|ｅｖｉｌ/);
    }
  });

  it('别人的设备 id 查不到名字（按 user_id 一起查）', async () => {
    const { db, box } = setup();
    db.devices.set('dddddddd-0000-4000-8000-000000000003', { user_id: B, label: 'B 的手机' });
    await exportOnce(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000003' });
    expect(box[0]?.mail.text).not.toContain('B 的手机');
  });

  it('device_id 不是 uuid：bad_request，不计次数', async () => {
    const { db, box } = setup();
    const r = await exportOnce(db, box, { device_id: 'x' });
    expect(r.status).toBe(400);
    expect(db.counters.size).toBe(0);
  });

  it('带了令牌：无效回 vault_locked、旧令牌回 vault_relock，整个请求被拒、不计次数、不写 logs', async () => {
    const { db, box } = setup();
    expect(await (await exportOnce(db, box, {}, { 'x-vault-token': 'tok' })).json()).toEqual({ error: 'vault_locked' });
    expect(await (await exportOnce(db, box, {}, { 'x-vault-token': 'tok' }, { verifyVaultToken: async () => 'vault_relock' })).json()).toEqual({ error: 'vault_relock' });
    expect(await (await exportOnce(db, box, {}, { 'x-vault-token': '' })).json()).toEqual({ error: 'vault_locked' });
    expect(db.counters.size).toBe(0);
    expect(db.logs).toEqual([]);
  });

  it('带了有效令牌：vault = cipher，隐私记行只有密文列', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [{ id: 'n2', user_id: A, is_private: true, body: 'plain-should-not-leak', body_enc: 'C' }]);
    const r = await exportOnce(db, box, {}, { 'x-vault-token': 'tok' }, { verifyVaultToken: async (u, t) => (u === A && t === 'tok' ? 'ok' : 'vault_locked') });
    const doc = await unzip(r);
    expect(doc.vault).toBe('cipher');
    expect(JSON.stringify(doc)).not.toContain('plain-should-not-leak');
  });

  it('读到别人的行（service role 绕过 RLS，条件写错时）：整次失败，不回文件', async () => {
    const { db, box } = setup();
    const store = db.accountStore();
    const logs: string[] = [];
    const r = await exportOnce(db, box, {}, {}, { log: (c) => logs.push(c), store: { ...store, readPage: async (t) => (t === 'settings' ? [{ id: 'x', user_id: B }] : []) } });
    expect(r.status).toBe(503);
    expect(logs).toContain('export_foreign_row');
  });

  it('分页读：超过一页的表全读出来；按主键往后翻（gt 上一页最后一个 id），不用 offset（K3 安全审查低 7）', async () => {
    const { db, box } = setup();
    const ids = Array.from({ length: 2345 }, (_, i) => `t${String(i).padStart(5, '0')}`);
    db.tables.set('todos', ids.map((id) => ({ id, user_id: A })));
    const doc = await unzip(await exportOnce(db, box));
    expect((doc.tables as Record<string, { id: string }[]>).todos?.map((r) => r.id)).toEqual(ids);
    expect(db.pageReads.filter((p) => p.table === 'todos').map((p) => p.after)).toEqual([null, ids[EXPORT_PAGE - 1], ids[2 * EXPORT_PAGE - 1]]);
  });

  it('logs 超过 25,000 行照样导出（K3 安全审查必改 2：logs 每人每天 2,000 条、留 90 天，上限另算）', async () => {
    const { db, box } = setup();
    for (let i = 0; i < 30_000; i++) db.logs.push({ id: 1_000_000 + i, user_id: A, act: 'x', device: null, t: i });
    const r = await exportOnce(db, box);
    expect(r.status).toBe(200);
    const logs = (await unzip(r)).tables as Record<string, { id: number }[]>;
    expect(logs.logs).toHaveLength(30_001);   // 加上导出前先写的那一条
    expect(EXPORT_MAX_LOG_ROWS).toBeGreaterThanOrEqual(2000 * 90);
    expect(TABLES.find((t) => t.name === 'logs')?.maxRows).toBe(EXPORT_MAX_LOG_ROWS);
    expect(TABLES.find((t) => t.name === 'todos')?.maxRows).toBe(EXPORT_MAX_ROWS);
  });

  it('超过表的行数上限：503，照常扣次数（数据本身的问题，重试一样失败；K3 复审 B），3 次以后 rate_limited', async () => {
    const { db, box } = setup();
    db.tables.set('todos', Array.from({ length: 2500 }, (_, i) => ({ id: `t${String(i).padStart(5, '0')}`, user_id: A })));
    const small = TABLES.map((t) => (t.name === 'todos' ? { ...t, maxRows: 2000 } : t));
    const logs: string[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT + 1; i++) {
      statuses.push((await exportOnce(db, box, {}, {}, { exportTables: small, log: (c) => logs.push(c) })).status);
    }
    expect(statuses).toEqual([503, 503, 503, 429]);
    expect(logs.filter((c) => c === 'export_too_many_rows')).toHaveLength(ACCOUNT_DAILY_LIMIT);
    expect(logs).not.toContain('export_refund_failed');
    expect([...db.counters.values()]).toEqual([ACCOUNT_DAILY_LIMIT + 1]);
  });

  it('原文超过总字节上限（可注入）：503 export_too_large，照常扣次数', async () => {
    const { db, box } = setup();
    db.tables.set('todos', Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, user_id: A, title: 'x'.repeat(200) })));
    const logs: string[] = [];
    const r = await exportOnce(db, box, {}, {}, { exportMaxRawBytes: 4096, log: (c) => logs.push(c) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(logs).toContain('export_too_large');
    expect([...db.counters.values()]).toEqual([1]);
    expect(box).toEqual([]);   // 没导出就不发导出通知
    // 不注入时同一份数据照常导出
    expect((await exportOnce(db, box)).status).toBe(200);
  });

  it('读到别人的行（ExportError）也照常扣次数', async () => {
    const { db, box } = setup();
    const store = db.accountStore();
    await exportOnce(db, box, {}, {}, { store: { ...store, readPage: async (t) => (t === 'settings' ? [{ id: 'x', user_id: B }] : []) } });
    expect([...db.counters.values()]).toEqual([1]);
  });

  it('临时性失败退回这一次：数据库出错（db_error）、写不进 logs；退回本身出错只记日志', async () => {
    const { db, box } = setup();
    db.fail.add('readPage');
    expect((await exportOnce(db, box)).status).toBe(503);
    db.fail.delete('readPage');
    db.fail.add('insertLog:export');
    expect((await exportOnce(db, box)).status).toBe(503);
    expect(db.counters.get(`${keys.account(A, T0)}|${Math.floor(T0 / 1000 / 86400)}`)).toBe(0);
    expect(db.counters.get(`${keys.exportRefund(A, T0)}|${Math.floor(T0 / 1000 / 86400)}`)).toBe(2);   // 退回了 2 次
    db.fail.add('readPage');
    db.fail.delete('insertLog:export');
    db.fail.add('refundRate');
    const logs: string[] = [];
    expect((await exportOnce(db, box, {}, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs).toEqual(['db_error', 'export_refund_failed']);
    expect(db.counters.get(`${keys.account(A, T0)}|${Math.floor(T0 / 1000 / 86400)}`)).toBe(1);
  });

  it('退回每人每天最多 3 次（K3 复审低 2）：第 4 次 db_error 不再退回、照常扣', async () => {
    const { db, box } = setup();
    db.fail.add('readPage');
    const logs: string[] = [];
    for (let i = 0; i < 3; i++) expect((await exportOnce(db, box, {}, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    const w = Math.floor(T0 / 1000 / 86400);
    expect(db.counters.get(`${keys.account(A, T0)}|${w}`)).toBe(0);   // 前 3 次都退回了
    expect(logs).not.toContain('export_refund_capped');
    expect((await exportOnce(db, box, {}, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs.at(-1)).toBe('export_refund_capped');
    expect(db.counters.get(`${keys.account(A, T0)}|${w}`)).toBe(1);   // 第 4 次扣了
    expect(COUNTER_KEY.test(keys.exportRefund(A, T0))).toBe(true);
  });

  it('devices 不导出推送订阅的密钥和会话 id（清单 exportOmitCols，K3 安全审查低 8）', async () => {
    const { db, box } = setup();
    db.tables.set('devices', [{
      id: 'dddddddd-0000-4000-8000-000000000001', user_id: A, label: '我的 iPhone', platform: 'ios',
      push_endpoint: 'https://push.example/abc', p256dh: 'P256', auth: 'AUTHKEY', session_id: 'eeeeeeee-0000-4000-8000-000000000001',
    }]);
    const dev = TABLES.find((t) => t.name === 'devices');
    expect(dev?.omitCols).toEqual(['push_endpoint', 'p256dh', 'auth', 'session_id']);
    const doc = await unzip(await exportOnce(db, box));
    const row = (doc.tables as Record<string, Record<string, unknown>[]>).devices?.[0];
    expect(row).toMatchObject({ label: '我的 iPhone', platform: 'ios' });
    for (const c of ['push_endpoint', 'p256dh', 'auth', 'session_id']) expect(row, c).not.toHaveProperty(c);
    expect(JSON.stringify(doc)).not.toMatch(/AUTHKEY|P256|push\.example|eeeeeeee/);
  });
});
