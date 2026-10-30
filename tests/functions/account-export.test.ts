// account 函数 export 的单元测试之一：挑表、隐私记过滤、start 一步（架构 0.47 续 ①“开始”，0.47 第 18、19 条；TC-B1-67 的函数一半）。
//   start 只计次、建任务、写 logs、发通知，不读用户数据；预检前三道闸（Q1）、大小预检（超 480 MB 413、超时和忙 try_later，都不扣次数）、
//   建任务或写 logs 失败退回次数并删掉任务行（N2）、导出通知里的设备名。part 一步在 account-export-part.test.ts，
//   上限和游标在 account-export-limits.test.ts。
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DAILY_LIMIT, cleanDeviceLabel, EXPORT_LIMITS, exportRows, isVaultRow, keys,
} from '../../supabase/functions/account/core.ts';
import { A, B, accountSetup as setup, COUNTER_KEY, T0 } from './account-fakes.ts';
import { call, part, start, TABLES, uid } from './account-export-harness.ts';

const DEV = 'dddddddd-0000-4000-8000-000000000001';
const E1 = 'eeeeeeee-0000-4000-8000-0000000000e1';

describe('account export：挑表和隐私记过滤', () => {
  it('按清单挑表：只要 public、export = json 的；private 的表、vault 系列、向量一律不在；主键类型按表定', () => {
    const names = TABLES.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(['profiles', 'settings', 'devices', 'events', 'todos', 'notes', 'note_images', 'note_files', 'anniversaries']));
    for (const no of ['vault', 'vault_credentials', 'device_secrets', 'note_vectors', 'embed_queue', 'vault_preview', 'vault_ai', 'counters', 'tombstones', 'app_config', 'pending_deletions']) {
      expect(names, no).not.toContain(no);
    }
    expect(TABLES.filter((t) => t.vaultRows).map((t) => t.name).sort()).toEqual(['note_files', 'note_images', 'notes']);
    expect(Object.fromEntries(TABLES.map((t) => [t.name, t.keyType]))).toMatchObject({ profiles: 'self', logs: 'int', notes: 'uuid', settings: 'uuid' });
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
    const rows = [
      { id: '1', user_id: A, is_private: false, body: 'hello' },
      { id: '2', user_id: A, is_private: true, body: 'secret', ...Object.fromEntries(notes.vaultRows.cipherCols.map((c) => [c, 'CIPHER'])) },
    ];
    expect(exportRows(notes, rows, 'omitted').map((r) => r.id)).toEqual(['1']);
    const withVault = exportRows(notes, rows, 'cipher');
    expect(withVault).toHaveLength(2);
    expect(withVault[1]).not.toHaveProperty('body');
    for (const c of notes.vaultRows.cipherCols) expect(withVault[1]).toHaveProperty(c, 'CIPHER');
  });
});

describe('account export start（0.47 续 ①“开始”）', () => {
  it('只回 {ok, export_id, exported_at}；扣一次、建任务、记 logs export（code = export_id、t = 开始时刻）、发通知；不读任何用户数据', async () => {
    const { db, box } = setup();
    db.tables.set('notes', [{ id: uid('11111111', 1), user_id: A, is_private: false, body: 'a-note' }]);
    db.devices.set(DEV, { user_id: A, label: '我的 iPhone' });
    const r = await start(db, box, { device_id: DEV }, { newId: () => E1 }, { 'x-proxy-secret': 'proxy-secret', 'x-lemo-geo': `KR|${encodeURIComponent('서울')}` });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, export_id: E1, exported_at: new Date(T0).toISOString() });
    expect(db.pageReads).toEqual([]);   // 这一步不读数据
    expect(db.count(keys.account(A, T0))).toBe(1);
    expect(db.count(keys.exportJob(A, E1, 'omitted', 'aaaaaaaa-s1'))).toBe(0);   // 任务行，还没取片
    expect(db.logs).toEqual([expect.objectContaining({ act: 'export', code: E1, t: T0, device: DEV })]);
    expect(box).toHaveLength(1);
    expect(box[0]?.mail.text).toContain('我的 iPhone');
    expect(box[0]?.mail.text).toContain('KR 서울');
    expect(box[0]?.mail.text).toContain('2026年10月29日 12:00（Asia/Seoul）');
    expect(box[0]?.mail.text).not.toMatch(/http|a-note/);
  });

  it('没写 step 或写错：bad_request，不计次数', async () => {
    const { db, box } = setup();
    expect((await call(db, box, { action: 'export' })).status).toBe(400);
    expect((await call(db, box, { action: 'export', step: 'all' })).status).toBe(400);
    expect(db.counters.size).toBe(0);
  });

  it('device_id 不是 uuid：bad_request，不计次数、不预检', async () => {
    const { db, box } = setup();
    expect((await start(db, box, { device_id: 'x' })).status).toBe(400);
    expect(db.counters.size).toBe(0);
    expect(db.sizeCalls).toBe(0);
  });

  it('带了令牌：无效回 vault_locked、旧令牌回 vault_relock、空串 vault_locked，整个请求被拒、不计次数、不写 logs', async () => {
    const { db, box } = setup();
    expect(await (await start(db, box, {}, {}, { 'x-vault-token': 'tok' })).json()).toEqual({ error: 'vault_locked' });
    expect(await (await start(db, box, {}, { verifyVaultToken: async () => 'vault_relock' }, { 'x-vault-token': 'tok' })).json()).toEqual({ error: 'vault_relock' });
    expect(await (await start(db, box, {}, {}, { 'x-vault-token': '' })).json()).toEqual({ error: 'vault_locked' });
    expect(db.counters.size).toBe(0);
    expect(db.logs).toEqual([]);
  });

  it('发信失败不当作“没导出”：照样回 export_id，另记一条 export_mail_failed（code = export 那一行 t 的 ISO）', async () => {
    const { db, box } = setup();
    const r = await start(db, box, {}, { sendMail: async () => false, newId: () => E1 });
    expect(r.status).toBe(200);
    expect(db.logs.map((l) => l.act)).toEqual(['export', 'export_mail_failed']);
    expect(db.logs[1]?.code).toBe(new Date(db.logs[0]?.t ?? 0).toISOString());
    expect(db.logs[0]?.code).toBe(E1);
  });

  it('设备查不到写“未知设备”；没经转发层写“未知地区”；像链接的、别人的设备名都不用', async () => {
    const { db, box } = setup();
    db.devices.set('dddddddd-0000-4000-8000-000000000002', { user_id: A, label: 'http://evil.example' });
    db.devices.set('dddddddd-0000-4000-8000-000000000003', { user_id: B, label: 'B 的手机' });
    await start(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000002' }, {}, { 'x-lemo-geo': 'KR|Seoul' });
    await start(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000003' });
    expect(box[0]?.mail.text).toContain('设备：未知设备');
    expect(box[0]?.mail.text).toContain('地区：未知地区');
    expect(box[0]?.mail.text).not.toMatch(/http|evil/);
    expect(box[1]?.mail.text).not.toContain('B 的手机');
  });

  it('设备名过滤（K3 安全审查必改 1、复审 A、低 1）：像域名、网址、邮箱、电话的整个不用', () => {
    for (const bad of [
      '访问 evil.com 领取', 'ｅｖｉｌ．ｃｏｍ', 'evil。com', 'evil｡com', 'ev\u200bil.com', '\u202emoc.live', 'support@lemo', 'a://b', 'www 点 x',
      '示例.中国 验证', 'пример.рф', '192.168.10.5', 'evil.c' + '\u043e' + 'm', 'iPhone 15.2', '小王。手机',
      '客服 02-1234-5678', '回拨 010 1234 5678', '０１０１２３４５６７８', '+82 10 1234 5678', '1234567',
    ]) expect(cleanDeviceLabel(bad), JSON.stringify(bad)).toBeNull();
    for (const ok of ['iPhone 15 Pro', 'Galaxy S24 Ultra 512GB', 'Pixel 9 Pro XL', '123456 号机']) expect(cleanDeviceLabel(ok), ok).toBe(ok);
    expect(cleanDeviceLabel('ｉＰａｄ Pro 13')).toBe('iPad Pro 13');
    expect(cleanDeviceLabel('Pixel\u200b 9\u202e')).toBe('Pixel 9');
    expect(cleanDeviceLabel('长'.repeat(60))).toBe('长'.repeat(40));
  });
});

describe('account export start：大小预检和它前面的三道闸（0.47 第 18、19 条，安全复核 Q1、Q4，回查 R2）', () => {
  it('当天导出次数已满：只读查到 3 次就回 429，不预检、不扣 export-size、不再扣 account', async () => {
    const { db, box } = setup();
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT; i++) expect((await start(db, box)).status).toBe(200);
    const calls = db.sizeCalls;
    const logs: string[] = [];
    const r = await start(db, box, {}, { log: (c) => logs.push(c) });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.sizeCalls).toBe(calls);
    expect(db.count(keys.exportSize(A, T0))).toBe(ACCOUNT_DAILY_LIMIT);
    expect(db.count(keys.account(A, T0))).toBe(ACCOUNT_DAILY_LIMIT);
    expect(logs).toEqual([expect.stringMatching(/^export_size_rate_limited u=- ms=\d+$/)]);
  });

  it('预检专用限流：一天 6 次，第 7 次 429、不预检（超大账号每次 413 也压不了库第 7 次）', async () => {
    const { db, box } = setup();
    db.sizeResult = EXPORT_LIMITS.maxTotalRawBytes + 1;
    for (let i = 0; i < EXPORT_LIMITS.sizeCheckDailyLimit; i++) expect((await start(db, box)).status).toBe(413);
    expect(db.sizeCalls).toBe(EXPORT_LIMITS.sizeCheckDailyLimit);
    expect((await start(db, box)).status).toBe(429);
    expect(db.sizeCalls).toBe(EXPORT_LIMITS.sizeCheckDailyLimit);
    expect(db.count(keys.account(A, T0))).toBe(0);   // 413 都没扣导出次数
  });

  it('超过 480 MB：413 export_too_large，不扣次数、不建任务、不写 logs、不发信；回应不带估算值；函数日志记哈希和耗时', async () => {
    const { db, box } = setup();
    db.sizeResult = EXPORT_LIMITS.maxTotalRawBytes + 1;
    const logs: string[] = [];
    const r = await start(db, box, {}, { log: (c) => logs.push(c), userHash: async (u) => (u === A ? 'h-of-a' : 'x') });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'export_too_large' });
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect([...db.counters.keys()].some((k) => k.startsWith('export-job:'))).toBe(false);
    expect(db.logs).toEqual([]);
    expect(box).toEqual([]);
    expect(logs).toEqual([expect.stringMatching(/^export_size_rejected u=h-of-a ms=\d+$/)]);
    expect(logs.join()).not.toContain(A);
  });

  it('正好 480 MB 放行；预检按导出模式：没解锁时隐私记行不算', async () => {
    const { db, box } = setup();
    db.sizeResult = EXPORT_LIMITS.maxTotalRawBytes;
    expect((await start(db, box)).status).toBe(200);
    db.sizeResult = null;
    db.tables.set('notes', [
      { id: uid('11111111', 1), user_id: A, is_private: true, body_enc: 'x'.repeat(5000) },
      { id: uid('11111111', 2), user_id: A, is_private: false, body: 'y' },
    ]);
    expect(db.exportSizeOver(A, 'omitted', 1e9)).toBeLessThan(1000);
    expect(db.exportSizeOver(A, 'cipher', 1e9)).toBeGreaterThan(5000);
  });

  it('超时（-1）、出错：try_later，不扣导出次数；预检限流那一次照常算', async () => {
    const { db, box } = setup();
    const logs: string[] = [];
    db.sizeResult = -1;
    expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    db.sizeResult = null;
    db.fail.add('exportSizeOver');
    expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect(db.count(keys.exportSize(A, T0))).toBe(2);
    expect(logs.map((c) => c.split(' ')[0])).toEqual(['export_size_timeout', 'export_size_failed']);
  });

  it('别人在预检（-2，拿不到全局锁）：try_later，不扣导出次数，这一次预检限流退回去（回查 R2）', async () => {
    const { db, box } = setup();
    db.sizeResult = -2;
    const logs: string[] = [];
    for (let i = 0; i < 10; i++) expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(db.count(keys.exportSize(A, T0))).toBe(0);
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect(logs.every((c) => c.startsWith('export_size_busy '))).toBe(true);
    db.sizeResult = null;
    expect((await start(db, box)).status).toBe(200);   // 忙过去以后照常
  });
});

describe('account export start：扣了次数以后的失败（退回、删任务行，N2；S5）', () => {
  it('写不进 logs：try_later、退回当天这一次、删掉已建的任务行、不发信', async () => {
    const { db, box } = setup();
    db.fail.add('insertLog:export');
    const logs: string[] = [];
    const r = await start(db, box, {}, { newId: () => E1, log: (c) => logs.push(c) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect(db.count(keys.exportRefund(A, T0))).toBe(1);
    expect([...db.counters.keys()].some((k) => k.startsWith(`${keys.exportJob(A, E1, 'omitted', 'aaaaaaaa-s1')}|`))).toBe(false);
    expect(logs).toEqual(['export_log_failed']);
    expect(box).toEqual([]);
    // 删掉的任务取不了片：410
    db.fail.delete('insertLog:export');
    expect((await part(db, box, E1, null)).status).toBe(410);
  });

  it('建任务失败：try_later、退回；删任务行也失败只记错误码', async () => {
    const { db, box } = setup();
    db.fail.add('exportJobStart');
    db.fail.add('deleteCounterKey');
    const logs: string[] = [];
    expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs).toEqual(['export_job_failed', 'export_job_delete_failed']);
    expect(db.count(keys.account(A, T0))).toBe(0);
  });

  // TC-B1-138 ⑥（代码审查）：只在“同名任务行已存在”时不删；超时等其余失败照旧删（行可能已写进库、只是回应丢了）
  it('撞上已有的同名任务行（export_job_exists）：原有那一行不动，照常退回、回 try_later', async () => {
    const { db, box } = setup();
    expect((await start(db, box, {}, { newId: () => E1 })).status).toBe(200);
    const jobKey = keys.exportJob(A, E1, 'omitted', 'aaaaaaaa-s1');
    const before = [...db.counters].filter(([k]) => k.startsWith(`${jobKey}|`));
    expect(before).toHaveLength(1);
    const logs: string[] = [];
    expect((await start(db, box, {}, { newId: () => E1, log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs).toEqual(['export_job_failed', 'export_job_exists']);
    expect([...db.counters].filter(([k]) => k.startsWith(`${jobKey}|`))).toEqual(before);
    expect(db.count(keys.account(A, T0))).toBe(1);   // 第二次退回了
    expect((await part(db, box, E1, null)).status).toBe(200);   // 原来那次导出照常取
  });

  it('建任务超时、但那一行其实已写进库（回应丢了）：照旧删掉本次写的那一行，取片 410', async () => {
    const { db, box } = setup();
    const store = db.accountStore();
    const over = { ...store, exportJobStart: async (...a: Parameters<typeof store.exportJobStart>) => { await store.exportJobStart(...a); throw new Error('57014 canceling statement due to statement timeout'); } };
    const logs: string[] = [];
    expect((await start(db, box, {}, { store: over, newId: () => E1, log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs).toEqual(['export_job_failed']);
    expect([...db.counters.keys()].some((k) => k.startsWith(`${keys.exportJob(A, E1, 'omitted', 'aaaaaaaa-s1')}|`))).toBe(false);
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect((await part(db, box, E1, null)).status).toBe(410);
  });

  it('退回每人每天最多 3 次（K3 复审低 2）；退回本身出错只记日志', async () => {
    const { db, box } = setup();
    db.fail.add('insertLog:export');
    const logs: string[] = [];
    for (let i = 0; i < 3; i++) expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(db.count(keys.account(A, T0))).toBe(0);
    expect(logs).not.toContain('export_refund_capped');
    expect((await start(db, box, {}, { log: (c) => logs.push(c) })).status).toBe(503);
    expect(logs.at(-1)).toBe('export_refund_capped');
    expect(db.count(keys.account(A, T0))).toBe(1);
    const w2 = setup();
    w2.db.fail.add('insertLog:export');
    w2.db.fail.add('refundRate');
    const logs2: string[] = [];
    expect((await start(w2.db, w2.box, {}, { log: (c) => logs2.push(c) })).status).toBe(503);
    expect(logs2).toEqual(['export_log_failed', 'export_refund_failed']);
  });

  it('计数键都过得了 counters 的三段约束（导出任务键第三段点分、不含冒号）', () => {
    for (const k of [keys.exportRefund(A, T0), keys.exportSize(A, T0), keys.exportPart(A, T0), keys.exportJob(A, E1, 'cipher', 'aaaaaaaa-5555-4000-8000-000000000001')]) {
      expect(COUNTER_KEY.test(k), k).toBe(true);
    }
  });
});
