// tools/e2e/export-load-preview.mjs 的护栏单测（只引 export-load-preview-guards.mjs 的纯函数，不连任何库、不跑 main；主脚本只读源码文本）：预览 ref 和 preview-login.ts 一致、参数上限、删号前核对的每一条反例，
// 以及源码里没有 service key 进 account 调用、没有打印响应体的写法。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREVIEW_REF as LOGIN_REF } from '../../tools/e2e/preview-login.ts';
import { cleanupGuard, cleanupSince, MAX_LOG_ROWS, MAX_SYNC_ROWS, ownerList, parseArgs, PREVIEW_REF, seedRows } from '../../tools/e2e/export-load-preview-guards.mjs';

const SRC = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'e2e', 'export-load-preview.mjs'), 'utf8');
const ID = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'e2e-export-1790000000000@lemomemo.test';
const RUN_AT = '2026-10-31T01:00:00.000000+00:00';
const good = { id: ID, fetched: { email: EMAIL, created_at: '2026-10-31T01:00:01Z' }, created: EMAIL, runAt: RUN_AT, admins: [], owners: ['owner@example.com'] };

describe('export-load-preview 护栏', () => {
  it('预览 ref 和 preview-login.ts 一致，不是正式 ref', () => {
    expect(PREVIEW_REF).toBe(LOGIN_REF);
    expect(PREVIEW_REF).not.toBe('uvlnwawwsdfihziaielj');
    expect(SRC).toContain('https://${PREVIEW_REF}.supabase.co');
    expect(SRC).toContain("from './export-load-preview-guards.mjs'");
  });

  it('参数：默认取上限，超过上限或不认识的参数都拒', () => {
    expect(parseArgs([])).toEqual({ sync: MAX_SYNC_ROWS, logs: MAX_LOG_ROWS, local: false });
    expect(parseArgs(['--sync-rows', '10', '--log-rows', '20', '--rehearse-local'])).toEqual({ sync: 10, logs: 20, local: true });
    expect(parseArgs(['--sync-rows', String(MAX_SYNC_ROWS + 1)]).error).toBe('too_many_rows');
    expect(parseArgs(['--log-rows', String(MAX_LOG_ROWS + 1)]).error).toBe('too_many_rows');
    expect(parseArgs(['--sync-rows', '-1']).error).toBe('bad_args');
    expect(parseArgs(['--ref', 'uvlnwawwsdfihziaielj']).error).toBe('bad_args');
    expect(parseArgs(['--sync-rows']).error).toBe('bad_args');
  });

  it('补删模式参数（D2 第 4 点）：--cleanup 要 uuid、不能和造数参数一起用；--since 要能解析、只能跟 --cleanup', () => {
    expect(parseArgs(['--cleanup', ID])).toEqual({ cleanup: ID, since: null, local: false });
    expect(parseArgs(['--cleanup', ID, '--since', '2026-10-31T00:00:00Z', '--rehearse-local'])).toEqual({ cleanup: ID, since: '2026-10-31T00:00:00Z', local: true });
    expect(parseArgs(['--cleanup', 'not-a-uuid']).error).toBe('bad_args');
    expect(parseArgs(['--cleanup', 'AAAAAAAA-2222-4333-8444-555555555555']).error).toBe('bad_args');   // 大写不认
    expect(parseArgs(['--cleanup']).error).toBe('bad_args');
    expect(parseArgs(['--cleanup', ID, '--sync-rows', '10']).error).toBe('bad_args');
    expect(parseArgs(['--cleanup', ID, '--since', 'yesterday']).error).toBe('bad_args');
    expect(parseArgs(['--since', '2026-10-31T00:00:00Z']).error).toBe('bad_args');
  });

  it('补删的“建号晚于”时刻：默认数据库时间前 24 小时；给的时刻只能在 24 小时内、不能晚于现在', () => {
    const now = '2026-10-31T12:00:00.000000+00:00';
    expect(cleanupSince(null, now)).toEqual({ at: '2026-10-30T12:00:00.000Z' });
    expect(cleanupSince('2026-10-30T12:00:00Z', now)).toEqual({ at: '2026-10-30T12:00:00.000Z' });
    expect(cleanupSince('2026-10-30T11:59:59Z', now)).toEqual({ error: 'since_out_of_range' });
    expect(cleanupSince('2026-10-31T12:00:01Z', now)).toEqual({ error: 'since_out_of_range' });
    expect(cleanupSince(null, null)).toEqual({ error: 'db_time_unreadable' });
  });

  it('负责人名单：没设为 null，设了就规整成小写', () => {
    expect(ownerList(undefined)).toBeNull();
    expect(ownerList('  ')).toBeNull();
    expect(ownerList(' A@X.com ,b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('删号前核对：全对才放行；没设名单只记“跳过”', () => {
    expect(cleanupGuard(good)).toEqual({ ok: true, reasons: [], notes: [] });
    const r = cleanupGuard({ ...good, owners: null });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual(['PREVIEW_OWNER_EMAILS 没设，跳过']);
  });

  it.each([
    ['取不回账号', { fetched: null }, 'user_unreadable'],
    ['邮箱和本次建的不一样', { fetched: { ...good.fetched, email: 'e2e-export-1790000000001@lemomemo.test' } }, 'email_mismatch'],
    ['不是 .test 邮箱', { fetched: { ...good.fetched, email: 'someone@gmail.com' }, created: 'someone@gmail.com' }, 'not_test_email'],
    ['.test 后缀伪装', { fetched: { ...good.fetched, email: 'e2e-export-1@lemomemo.test.evil.com' }, created: 'e2e-export-1@lemomemo.test.evil.com' }, 'not_test_email'],
    ['不是本脚本的邮箱形状', { fetched: { ...good.fetched, email: 'e2e-1@lemomemo.test' }, created: 'e2e-1@lemomemo.test' }, 'not_test_email'],
    ['账号建在运行开始之前', { fetched: { ...good.fetched, created_at: '2026-10-31T00:59:59Z' } }, 'created_before_run'],
    ['建号时间读不出', { fetched: { ...good.fetched, created_at: null } }, 'created_before_run'],
    ['admins 查不了', { admins: null }, 'admins_unreadable'],
    ['是管理员', { admins: [ID] }, 'is_admin'],
    ['在负责人名单里', { owners: ownerList(EMAIL.toUpperCase()) }, 'owner_email'],
  ])('删号前核对拒：%s', (_n, patch, reason) => {
    const r = cleanupGuard({ ...good, ...patch });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(reason);
  });

  it('造数：行数按参数、每行 user_id 是本人、附件挂在本人的笔记上', () => {
    const rows = seedRows(ID, 3, 5);
    expect(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length]))).toEqual({
      profiles: 1, settings: 3, devices: 3, events: 3, todos: 3, categories: 3, notes: 3, note_images: 3, note_files: 3, anniversaries: 3, logs: 5,
    });
    expect(Object.values(rows).flat().every((x) => x.user_id === ID)).toBe(true);
    const nids = new Set(rows.notes.map((n) => n.id));
    expect([...rows.note_images, ...rows.note_files].every((x) => nids.has(x.note_id) && x.path.startsWith(`${ID}/`))).toBe(true);
  });

  it('源码：调 account 只带用户 jwt；失败不带响应体', () => {
    // 第三个参数只放带超时的 fetch 和每片前的中断检查，不带任何头
    expect(SRC).toMatch(/runExport\(`\$\{T\.base\}\/functions\/v1\/account`, \{ authorization: `Bearer \$\{jwt\}` \}, \{\s*fetch: \(u, i\) => f\(u, \{ \.\.\.i, signal: AbortSignal\.timeout\(PART_TIMEOUT_MS\) \}\),[^\n]*\n\s*beforePart: /);
    // 每个请求都有超时（代码审查）：REST、Auth 60 秒；导出每片 180 秒，大于函数 150 秒墙钟
    expect(SRC).toMatch(/await f\(T\.base \+ path, \{ \.\.\.init, signal: AbortSignal\.timeout\(REQ_TIMEOUT_MS\),/);
    expect(SRC).toMatch(/export const REQ_TIMEOUT_MS = 60_000;/);
    expect(SRC).toMatch(/export const PART_TIMEOUT_MS = 180_000;/);
    expect(SRC).not.toMatch(/console\.(log|error)\([^)]*(text|body|key|jwt)/);
    expect(SRC).not.toMatch(/E2E_PREVIEW_SERVICE_KEY[^\n]*console/);
  });
});
