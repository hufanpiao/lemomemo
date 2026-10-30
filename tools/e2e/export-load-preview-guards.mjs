// tools/e2e/export-load-preview.mjs 的护栏纯函数和造数（拆出来给 tests/build/export-load-preview.test.ts 直接测：不引 real-backend.mjs、不起子进程、不连网）。
import { createHash, randomUUID } from 'node:crypto';
import { zh } from './export-load-lib.mjs';

/** 预览项目的 ref（公开值，和 tools/e2e/preview-login.ts 的 PREVIEW_REF 一致） */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';
export const MAX_DB_BYTES = 250 * 1024 * 1024;
export const MAX_SYNC_ROWS = 5000;
export const MAX_LOG_ROWS = 45000;
export const TEST_EMAIL = /^e2e-export-\d{13}@lemomemo\.test$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 补删模式里“建号时间晚于”的时刻最早只能往前推 24 小时（安全审查 D2 第 4 点） */
export const CLEANUP_MAX_LOOKBACK_MS = 24 * 3600 * 1000;

/**
 * 解析参数；不合规矩返回 { error }。
 * 补删模式（安全审查 D2 第 4 点）：--cleanup <uid> [--since <ISO 时刻>] [--rehearse-local]，不能和造数参数一起用。
 */
export function parseArgs(args) {
  const get = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const known = new Set(['--sync-rows', '--log-rows', '--rehearse-local', '--cleanup', '--since']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) return { error: 'bad_args' };
    if (args[i] !== '--rehearse-local') i++;
  }
  const local = args.includes('--rehearse-local');
  if (args.includes('--cleanup')) {
    if (args.includes('--sync-rows') || args.includes('--log-rows')) return { error: 'bad_args' };
    const id = get('cleanup');
    if (!UUID.test(id ?? '')) return { error: 'bad_args' };
    const since = get('since', null);
    if (since !== null && !Number.isFinite(Date.parse(since ?? ''))) return { error: 'bad_args' };
    return { cleanup: id, since, local };
  }
  if (args.includes('--since')) return { error: 'bad_args' };
  const sync = get('sync-rows', String(MAX_SYNC_ROWS));
  const logs = get('log-rows', String(MAX_LOG_ROWS));
  if (!/^\d+$/.test(sync ?? '') || !/^\d+$/.test(logs ?? '')) return { error: 'bad_args' };
  if (Number(sync) > MAX_SYNC_ROWS || Number(logs) > MAX_LOG_ROWS) return { error: 'too_many_rows' };
  return { sync: Number(sync), logs: Number(logs), local };
}

/**
 * 补删模式的“建号时间晚于”时刻：dbNow 是 db_size_bytes() 回的数据库时间。没给 since 就取 dbNow 前 24 小时；
 * 给了就必须在 [dbNow − 24 小时, dbNow] 里，否则 { error }（不能用很早的时刻把老账号也放进来）。
 */
export function cleanupSince(since, dbNow) {
  const now = Date.parse(dbNow ?? '');
  if (!Number.isFinite(now)) return { error: 'db_time_unreadable' };
  if (since === null || since === undefined) return { at: new Date(now - CLEANUP_MAX_LOOKBACK_MS).toISOString() };
  const t = Date.parse(since);
  if (!Number.isFinite(t) || t < now - CLEANUP_MAX_LOOKBACK_MS || t > now) return { error: 'since_out_of_range' };
  return { at: new Date(t).toISOString() };
}

/** 逗号分隔的负责人邮箱（规整成小写）；没设返回 null */
export function ownerList(raw) {
  if (raw === undefined || raw.trim() === '') return null;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 删号前的核对（护栏 ⑥）。fetched：按 id 取回的 { email, created_at }；created：本次建号时的邮箱；runAt：库大小查询回的 at；
 * admins：private.admins 的 user_id 列表（查不了传 null）；owners：ownerList() 的结果。返回 { ok, reasons, notes }。
 */
export function cleanupGuard({ id, fetched, created, runAt, admins, owners }) {
  const reasons = [];
  const notes = [];
  const email = fetched?.email ?? null;
  if (!fetched) reasons.push('user_unreadable');
  else {
    if (email !== created) reasons.push('email_mismatch');
    if (typeof email !== 'string' || !email.endsWith('@lemomemo.test') || !TEST_EMAIL.test(email)) reasons.push('not_test_email');
    const c = Date.parse(fetched.created_at ?? '');
    const a = Date.parse(runAt ?? '');
    if (!Number.isFinite(c) || !Number.isFinite(a) || c < a) reasons.push('created_before_run');
  }
  if (admins === null) reasons.push('admins_unreadable');
  else if (admins.includes(id)) reasons.push('is_admin');
  if (owners === null) notes.push('PREVIEW_OWNER_EMAILS 没设，跳过');
  else if (typeof email === 'string' && owners.includes(email.toLowerCase())) reasons.push('owner_email');
  return { ok: reasons.length === 0, reasons, notes };
}

/** 造数行（typ 档，和 export-load-seed.mjs 的常见长度一致） */
export function seedRows(uid, sync, logs) {
  const ms = (g) => 1790000000000 + g;
  const day = (g) => new Date(Date.UTC(2026, 0, 1) + (g % 700) * 86400000).toISOString().slice(0, 10);
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
  const notes = range(sync, (g) => ({ id: randomUUID(), user_id: uid, title: zh(10), body: zh(300), raw_text: '', created_at: ms(g), updated_at: ms(g) }));
  const nid = (g) => notes[(g - 1) % notes.length].id;
  return {
    profiles: [{ user_id: uid, display_name: 'export-load' }],
    settings: range(sync, (g) => ({ id: randomUUID(), user_id: uid, key: `load.${g}`, value: zh(4) })),
    devices: range(sync, () => ({ id: randomUUID(), user_id: uid, label: zh(10), platform: 'web', app_version: '4.0.0', last_seen_at: new Date().toISOString(), install_id: randomUUID() })),
    events: range(sync, (g) => ({ id: randomUUID(), user_id: uid, title: zh(20), date: day(g), time: '09:30', tz: 'Asia/Seoul', project: zh(4), note: zh(40), raw_text: zh(40), location: zh(10), short: zh(6), created_at: ms(g), updated_at: ms(g) })),
    todos: range(sync, (g) => ({ id: randomUUID(), user_id: uid, title: zh(20), due: day(g), project: zh(4), note: zh(40), raw_text: zh(40), short: zh(6), created_at: ms(g), updated_at: ms(g) })),
    categories: range(sync, (g) => ({ id: randomUUID(), user_id: uid, name: `${zh(Math.max(4 - String(g).length, 1))}${g}`, color: '#aabbcc', sort: g })),
    notes,
    note_images: sync ? range(sync, (g) => {
      const id = randomUUID();
      return { id, user_id: uid, note_id: nid(g), bucket: 'images', path: `${uid}/${nid(g)}/${id}.webp`, bytes: 300000, width: 1600, height: 1200, ai_status: 'done', ai_desc: zh(30), ai_tags: ['猫', '公园', '晴天'] };
    }) : [],
    note_files: sync ? range(sync, (g) => {
      const id = randomUUID();
      return { id, user_id: uid, note_id: nid(g), kind: 'pdf', path: `${uid}/${nid(g)}/${id}.pdf`, name: `${zh(12)}.pdf`, mime: 'application/pdf', bytes: 2000000,
        sha256: createHash('sha256').update(id).digest('hex'), pages: 12, text_excerpt: zh(200), check_status: 'ok', ai_status: 'done', ai_desc: zh(30), ai_tags: ['合同'],
        created_at: ms(g), updated_at: ms(g) };
    }) : [],
    anniversaries: range(sync, (g) => ({ id: randomUUID(), user_id: uid, kind: 'birthday', name: zh(6), calendar: 'solar', month: 1 + (g % 12), day: 1 + (g % 28), year: 1990,
      remind_offsets: [0, 7], remind_time: '09:00', note: zh(20), created_at: ms(g), updated_at: ms(g) })),
    logs: range(logs, (g) => ({ user_id: uid, t: 1790000000000 - g * 43200, device: randomUUID(), kind: 'run', act: 'update', src: 'page', coll: 'events', item_id: randomUUID(), fields: ['title', 'date'], code: null })),
  };
}
