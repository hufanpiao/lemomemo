// account 函数的单元测试（B1 K3；架构第 6 节 account、0.29 续第 92～96、129、131、134、137、138 条）：
// TC-B1-95 ③、98、99 ②（导出被拒）、100 ②④⑤⑧、103 ①②、104 ①、107 ③（邮件不放链接）的函数一半。
// 只测 core.ts（index.ts 只是把 supabase-js、requireActiveUser、Resend 接上）；数据库一半在 supabase/tests/rls/11_account_deletion.test.sql。
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DAILY_LIMIT, ACCOUNT_ERRS, ACCOUNT_STATUS_VALUES, confirmOk, cleanDeviceLabel, EXPORT_MAX_LOG_ROWS, EXPORT_MAX_ROWS, EXPORT_PAGE, exportRows, exportTablesOf, handle,
  isVaultRow, keys, otpFresh, RESTORE_DAILY_LIMIT,
} from '../../supabase/functions/account/core.ts';
import { ACCOUNT_ERROR_CODES, ACCOUNT_STATUSES, accountErrorCode, accountStatusResponse } from '../../shared/schema/account.ts';
import {
  deletionDoneMail, deletionReminderMail, deletionRequestedMail, exportMail, fmtWhen, restoredMail, safeTz,
} from '../../supabase/functions/_shared/account-mail.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { A, accountDeps, accountReq, B, Clock, DAY, FakeDb, H, type Outbox, T0 } from './account-fakes.ts';

const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;

function setup() {
  const clock = new Clock();
  const db = new FakeDb(clock);
  db.addUser(A, 'a@test.local');
  db.addUser(B, 'b@test.local', { ui_locale: 'ko-KR' });
  const box: Outbox[] = [];
  return { clock, db, box };
}

async function call(db: FakeDb, box: Outbox[], body: unknown, over: Parameters<typeof accountDeps>[2] = {}, headers: Record<string, string> = {}) {
  const deps = accountDeps(db, box, over);
  const res = await handle(accountReq(body, headers), deps);
  await Promise.all(deps.bg);
  return res;
}

describe('计数键、确认词、amr', () => {
  it('两个计数键过得了 counters 的 check 约束（附录 A：account、restore 按 UTC 日期）', () => {
    expect(keys.account(A, T0)).toBe(`account:${A}:20261029`);
    expect(keys.restore(A, T0)).toBe(`restore:${A}:20261029`);
    for (const k of [keys.account(A, T0), keys.restore(A, T0)]) expect(k).toMatch(COUNTER_KEY);
  });

  it('确认词（TC-B1-95 ②③）：去掉首尾空白后等于“注销”或“탈퇴”才算', () => {
    for (const ok of ['注销', ' 注销 ', '탈퇴', '\n탈퇴\t']) expect(confirmOk(ok), ok).toBe(true);
    for (const bad of [undefined, null, '', '注消', 'delete', '注销账号', '注 销', '注销。', 1, ['注销']]) expect(confirmOk(bad), String(bad)).toBe(false);
  });

  it('otp 在 10 分钟以内才算（只认 otp，取最近一次；允许 1 分钟时钟误差）', () => {
    const now = T0;
    const s = Math.floor(now / 1000);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 599 }]), now)).toBe(true);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 601 }]), now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 3000 }, { method: 'otp', timestamp: s - 10 }]), now)).toBe(true);
    expect(otpFresh(jwt([{ method: 'magiclink', timestamp: s - 10 }]), now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'password', timestamp: s - 10 }]), now)).toBe(false);
    expect(otpFresh(jwt(['otp']), now)).toBe(false);
    expect(otpFresh(jwt(undefined), now)).toBe(false);
    expect(otpFresh('not-a-jwt', now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s + 600 }]), now)).toBe(false);   // 未来很远：不信
  });
});

function jwt(amr: unknown): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: A, amr })}.sig`;
}

describe('account delete（申请注销）', () => {
  it('TC-B1-95 ③：confirm 不对一律 confirm_required，一条都不写（不计次数、没有 pending_deletions、disabled_at 不变）', async () => {
    const { db, box } = setup();
    for (const confirm of [undefined, '', 'delete', '注销账号', '注消']) {
      const body = confirm === undefined ? { action: 'delete' } : { action: 'delete', confirm };
      const r = await call(db, box, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'confirm_required' });
    }
    expect(db.pending.size).toBe(0);
    expect(db.profiles.get(A)?.disabled_at).toBeNull();
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('TC-B1-98：申请成功 → 冷静期（purge_after = +7 天、停用 deletion、全部会话吊销），数据不删，发第一封信', async () => {
    const { db, box } = setup();
    db.tables.set('settings', [{ id: 's1', user_id: A }]);
    const r = await call(db, box, { action: 'delete', confirm: ' 注销 ' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = (await r.json()) as { ok: boolean; purge_after: string };
    expect(j.ok).toBe(true);
    expect(Date.parse(j.purge_after)).toBe(T0 + 7 * DAY);
    expect(db.pending.get(A)?.purge_after).toBe(j.purge_after);
    expect(db.profiles.get(A)).toMatchObject({ disabled_reason: 'deletion' });
    expect([...db.sessions.values()]).not.toContain(A);
    expect([...db.revoked.values()].filter((u) => u === A)).toHaveLength(2);
    expect(db.deleted.size).toBe(0);
    expect(db.tables.get('settings')).toHaveLength(1);
    // 第一封信：时刻按本人时区（首尔），和 purge_after 一致；正文没有链接
    expect(box).toHaveLength(1);
    expect(box[0]?.to).toBe('a@test.local');
    expect(box[0]?.mail.text).toContain(fmtWhen(T0 + 7 * DAY, 'Asia/Seoul', 'zh-CN'));
    expect(box[0]?.mail.text).toContain('2026年11月5日 12:00（Asia/Seoul）');
    expect(box[0]?.mail.text).toContain('恢复账号');
    expect(box[0]?.mail.text).not.toMatch(/http|www\.|lemomemo\./i);
  });

  it('韩文界面的人收韩文信（ui_locale = ko-KR）', async () => {
    const { db, box } = setup();
    const r = await call(db, box, { action: 'delete', confirm: '탈퇴' }, { user: B });
    expect(r.status).toBe(200);
    expect(box[0]?.mail.text).toContain('2026년 11월 5일 12:00 (Asia/Seoul)');
  });

  it('TC-B1-103 ①：管理员申请注销回 admin_cannot_delete，什么都不写', async () => {
    const { db, box } = setup();
    db.admins.add(A);
    const r = await call(db, box, { action: 'delete', confirm: '注销' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'admin_cannot_delete' });
    expect(db.pending.size).toBe(0);
    expect(db.profiles.get(A)?.disabled_at).toBeNull();
    expect(box).toEqual([]);
  });

  it('rpc 那一道拦下的管理员（并发时刚加进 admins）也回 admin_cannot_delete', async () => {
    const { db, box } = setup();
    const store = db.accountStore();
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { store: { ...store, isAdmin: async () => false, requestDeletion: async () => { db.admins.add(A); return db.requestDeletion(A); } } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'admin_cannot_delete' });
  });

  it('TC-B1-65 ③：export、delete 合计每天 3 次：第 4 次 rate_limited，不进冷静期', async () => {
    const { db, box } = setup();
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT; i++) expect((await call(db, box, { action: 'export' })).status).toBe(200);
    const r = await call(db, box, { action: 'delete', confirm: '注销' });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.pending.size).toBe(0);
  });

  it('冷静期里再调 delete：被 requireActiveUser 拦成 account_pending_deletion（带 purge_after）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { session: 'aaaaaaaa-s3' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'account_pending_deletion', purge_after: db.pending.get(A)?.purge_after });
  });

  it('发信失败不影响申请成功（只记错误码）', async () => {
    const { db, box } = setup();
    const logs: string[] = [];
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { sendMail: async () => false, log: (c) => logs.push(c) });
    expect(r.status).toBe(200);
    expect(db.pending.has(A)).toBe(true);
    expect(logs).toContain('mail_failed:requested');
  });

  it('数据库出错：503 try_later，日志只有错误码', async () => {
    const { db, box } = setup();
    db.fail.add('requestDeletion');
    const logs: string[] = [];
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { log: (c) => logs.push(c) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(logs).toEqual(['db_error']);
  });
});

describe('account restore（冷静期里恢复）', () => {
  async function pendingA() {
    const s = setup();
    await call(s.db, s.box, { action: 'delete', confirm: '注销' });
    s.box.length = 0;
    s.db.sessions.set('aaaaaaaa-s9', A);   // 冷静期里用邮箱验证码重新登录（新会话）
    return s;
  }

  it('TC-B1-100 ②：刚用验证码登录 → 恢复成功，pending 删掉、两列清空，发“已恢复”（无链接）', async () => {
    const { db, box, clock } = await pendingA();
    clock.advance(2 * DAY);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(db.pending.has(A)).toBe(false);
    expect(db.profiles.get(A)).toMatchObject({ disabled_at: null, disabled_reason: null });
    expect(box.map((m) => m.mail.subject)).toEqual([restoredMail('zh-CN').subject]);
    expect(box[0]?.mail.text).not.toMatch(/http|www\./i);
  });

  it('TC-B1-100 ④：otp 超过 10 分钟回 reauth_required，仍在冷静期，不计次数', async () => {
    const { db, box, clock } = await pendingA();
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9', amr: [{ method: 'otp', timestamp: Math.floor(clock.ms / 1000) - 601 }] });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'reauth_required' });
    expect(db.pending.has(A)).toBe(true);
    expect([...db.counters.keys()].some((k) => k.startsWith('restore:'))).toBe(false);
  });

  it('TC-B1-100 ⑤：当天第 6 次被拒（每天 5 次）', async () => {
    const { db, box } = await pendingA();
    for (let i = 0; i < RESTORE_DAILY_LIMIT; i++) db.takeRate(keys.restore(A, db.clock.ms), RESTORE_DAILY_LIMIT, 86400);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.pending.has(A)).toBe(true);
  });

  it('TC-B1-108 ①：account-purge 已认领（purge_started_at 不为空）→ restore_too_late；purge_after 已到也一样', async () => {
    const { db, box, clock } = await pendingA();
    const d = db.pending.get(A);
    if (!d) throw new Error('no pending');
    d.purge_started_at = new Date(clock.ms).toISOString();
    expect(await (await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' })).json()).toEqual({ error: 'restore_too_late' });
    d.purge_started_at = null;
    clock.advance(7 * DAY);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'restore_too_late' });
    expect(db.pending.has(A)).toBe(true);
  });

  it('没申请注销的人调 restore：not_pending', async () => {
    const { db, box } = setup();
    const r = await call(db, box, { action: 'restore' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'not_pending' });
  });

  it('TC-B1-103 ②、104 ①：管理员停用的账号调 restore 回 account_disabled（requireActiveUser 拦下，rpc 那一道也拦）', async () => {
    const { db, box } = await pendingA();
    const p = db.profiles.get(A);
    if (!p) throw new Error('no profile');
    p.disabled_reason = 'admin';   // admin_set_disabled(A, true)
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'account_disabled' });
    expect(db.pending.has(A)).toBe(true);
    // 并发：鉴权时还是 deletion，进 rpc 前被管理员停用
    p.disabled_reason = 'deletion';
    const store = db.accountStore();
    const r2 = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9', store: { ...store, restore: async (u) => { p.disabled_reason = 'admin'; return db.restore(u); } } });
    expect(await r2.json()).toEqual({ error: 'account_disabled' });
    expect(box).toEqual([]);
  });

  it('TC-B1-100 ⑧、99 ②：冷静期里 export 回 account_pending_deletion（只有 restore 放行），不写 logs', async () => {
    const { db, box } = await pendingA();
    const r = await call(db, box, { action: 'export' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'account_pending_deletion' });
    expect(db.logs).toEqual([]);
  });
});

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

describe('account 的错误码（0.38 第 48 条：shared/schema/account.ts 的 accountErrorCode，前后端共用）', () => {
  it('core.ts 的 11 个码和 shared/schema/account.ts 一字不差、顺序一致（架构第 6 节那张表的顺序）', () => {
    expect([...ACCOUNT_ERRS]).toEqual([...ACCOUNT_ERROR_CODES]);
    expect(ACCOUNT_ERROR_CODES).toHaveLength(11);
    for (const c of ACCOUNT_ERRS) expect(accountErrorCode.safeParse(c).success, c).toBe(true);
    expect(accountErrorCode.safeParse('bad_request').success).toBe(false);   // 各函数共用的码不在 account 的表里
  });

  it('各路径回的错误码都在表里（或是共用的 bad_request、method_not_allowed）', async () => {
    const seen = new Set<string>();
    const { db, box } = setup();
    const grab = async (r: Response) => { const b = (await r.json()) as { error?: string }; if (b.error) seen.add(b.error); };
    await grab(await call(db, box, { action: 'delete', confirm: 'x' }));
    await grab(await call(db, box, { action: 'restore' }));
    await grab(await call(db, box, { action: 'export' }, {}, { 'x-vault-token': 'tok' }));
    await grab(await call(db, box, { action: 'nope' }));
    db.admins.add(A);
    await grab(await call(db, box, { action: 'delete', confirm: '注销' }));
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const c of seen) expect(c === 'bad_request' || accountErrorCode.safeParse(c).success, c).toBe(true);
  });
});

describe('account status（登录页判断要不要显示恢复页；10-30 架构师）', () => {
  /** 任何一个 store 方法被调到就抛错：status 不该碰数据库 */
  const untouchable = new Proxy({}, { get: (_t, k) => () => { throw new Error(`store_${String(k)}_touched`); } }) as never;

  async function statusOf(db: FakeDb, box: Outbox[], over: Parameters<typeof accountDeps>[2] = {}) {
    const logs: string[] = [];
    const r = await call(db, box, { action: 'status' }, { store: untouchable, log: (c) => logs.push(c), ...over });
    expect(logs).toEqual([]);   // 没走到 catch（store 被碰会变成 db_error）
    return r;
  }

  it('正常账号：200 {ok, status: active}；不写 logs、不计次数、不发信、不碰 store', async () => {
    const { db, box } = setup();
    const r = await statusOf(db, box);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'active' });
    expect(accountStatusResponse.parse(b)).toEqual(b);
    expect(db.logs).toEqual([]);
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('冷静期（重新登录的新会话）：放行，200 {ok, status: pending_deletion, purge_after}；什么都不写', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    box.length = 0;
    db.sessions.set('aaaaaaaa-s9', A);
    const counters = new Map(db.counters);
    const r = await statusOf(db, box, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'pending_deletion', purge_after: db.pending.get(A)?.purge_after });
    expect(typeof (b as { purge_after: unknown }).purge_after).toBe('string');
    expect(accountStatusResponse.parse(b)).toEqual(b);
    expect(db.counters).toEqual(counters);
    expect(db.logs).toEqual([]);
    expect(box).toEqual([]);
    expect(db.pending.has(A)).toBe(true);
    // 别的动作照旧被拦（只有 restore、status 放行）
    const e = await call(db, box, { action: 'export' }, { session: 'aaaaaaaa-s9' });
    expect(await e.json()).toMatchObject({ error: 'account_pending_deletion' });
  });

  it('冷静期但取不到 pending_deletions 行：purge_after 为 null（不猜时刻）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    db.pending.delete(A);
    db.sessions.set('aaaaaaaa-s9', A);
    const b = await (await statusOf(db, box, { session: 'aaaaaaaa-s9' })).json();
    expect(b).toEqual({ ok: true, status: 'pending_deletion', purge_after: null });
    expect(accountStatusResponse.parse(b)).toEqual(b);
  });

  it('管理员停用、没有 profile：200 {ok, status: disabled}（不是 403）；冷静期里被管理员停用的也是 disabled', async () => {
    const { db, box } = setup();
    const p = db.profiles.get(A);
    if (!p) throw new Error('no profile');
    p.disabled_at = '2026-10-29T00:00:00.000Z';
    p.disabled_reason = 'admin';
    const r = await statusOf(db, box);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true, status: 'disabled' });
    expect(accountStatusResponse.parse(b)).toEqual(b);
    db.profiles.delete(B);
    expect(await (await statusOf(db, box, { user: B })).json()).toEqual({ ok: true, status: 'disabled' });
    expect(db.logs).toEqual([]);
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('会话失效：照 requireActiveUser 原样回 401 session_revoked', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });   // 吊销全部会话
    const r = await statusOf(db, box);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'session_revoked' });
  });

  it('不占 export、delete 每天 3 次的额度：status 调多少次，导出照样能导 3 次', async () => {
    const { db, box } = setup();
    for (let i = 0; i < 10; i++) expect((await statusOf(db, box)).status).toBe(200);
    expect(db.counters.size).toBe(0);
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT; i++) expect((await call(db, box, { action: 'export' })).status).toBe(200);
    expect((await call(db, box, { action: 'export' })).status).toBe(429);
    expect(db.logs.map((l) => l.act)).toEqual(['export', 'export', 'export']);   // status 一条都没写
  });

  it('三种状态和 shared/schema/account.ts 的 ACCOUNT_STATUSES 一字不差', () => {
    expect([...ACCOUNT_STATUS_VALUES]).toEqual([...ACCOUNT_STATUSES]);
  });
});

describe('入口', () => {
  it('只收 POST；action 不认识、正文不是对象都回 bad_request', async () => {
    const { db, box } = setup();
    const deps = accountDeps(db, box);
    expect((await handle(new Request('https://x/account', { method: 'GET' }), deps)).status).toBe(405);
    for (const body of [null, [], 'x', { action: 'purge' }, { action: 1 }]) {
      expect((await handle(accountReq(body), deps)).status).toBe(400);
    }
  });

  it('TC-B1-65 ②：鉴权没过：原样回 requireActiveUser 的错误（会话被吊销的旧设备）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    const r = await call(db, box, { action: 'restore' });   // 原来的会话 aaaaaaaa-s1 已吊销
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'session_revoked' });
  });
});

describe('注销相关邮件（TC-B1-107 ③：四封都不放链接，时刻按本人时区）', () => {
  it('中、韩两种语言的四封信正文都没有 http、www、域名', () => {
    for (const loc of ['zh-CN', 'ko-KR'] as const) {
      const mails = [deletionRequestedMail(loc, T0, 'Asia/Seoul'), deletionReminderMail(loc, T0, 'Asia/Shanghai'), deletionDoneMail(loc), restoredMail(loc),
        exportMail(loc, T0, 'Asia/Seoul', null, null)];
      for (const m of mails) {
        expect(m.text, `${loc} ${m.subject}`).not.toMatch(/https?:|www\.|\.com|\.co\b|<a\s/i);
        expect(m.subject.length).toBeGreaterThan(0);
      }
    }
  });

  it('时刻按时区换算；时区名不对就按首尔', () => {
    expect(fmtWhen(T0, 'Asia/Shanghai', 'zh-CN')).toBe('2026年10月29日 11:00（Asia/Shanghai）');
    expect(fmtWhen(T0 + 13 * H, 'Asia/Seoul', 'ko-KR')).toBe('2026년 10월 30일 01:00 (Asia/Seoul)');
    expect(safeTz('Not/AZone')).toBe('Asia/Seoul');
    expect(safeTz(null)).toBe('Asia/Seoul');
    expect(fmtWhen(T0, 'Not/AZone', 'zh-CN')).toBe('2026年10月29日 12:00（Asia/Seoul）');
  });

  it('申请信写“恢复账号”和“留意垃圾邮件”（15.7 第 8 项）；提醒信写“恢复账号”', () => {
    expect(deletionRequestedMail('zh-CN', T0, 'Asia/Seoul').text).toMatch(/恢复账号[\s\S]*垃圾邮件/);
    expect(deletionReminderMail('zh-CN', T0, 'Asia/Seoul').text).toContain('恢复账号');
    expect(deletionReminderMail('ko-KR', T0, 'Asia/Seoul').text).toContain('계정 복구');
  });
});
