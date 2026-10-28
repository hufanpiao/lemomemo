// 各表“客户端可写列”的形状（架构 2.5）：outbox 入队前用严格版校验
// B0 只做严格版：多一个列、类型不对都拒收。读网络数据用的宽容版（不认识的枚举换成 unknown 等，0.27 第 1 点）B1 再加
// 列名以 3.3 C 的列级授权和附录 A 为准；清单和 grant 由 D1 比对，本文件和 grant、清单由 tests/build/rows-grants.test.ts 比对（B0 集成）
// 2026-10-28 B0 集成按 0001、0002 实际的列级授权核对过：events 补 notified_for、snooze_at；todos 补 due_time、remind_before_min、
//   notified_for、snooze_at；加 devices；insert、update 两边的列不一样（例如 devices.platform 只能 insert、deleted_at 只能 update），
//   新写 insertSchema / patchSchema 按表分开
import { z } from 'zod';

/** 改了本文件的形状或枚举，就把它加 1（2.6：本机库按 schema_v 整表重拉） */
export const SCHEMA_V = 2;   // 2：B0 集成按实际授权补列、加 devices

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const epochMs = z.number().int().nonnegative();

/** profiles：客户端只能改这三列（3.3） */
export const profilesWrite = z.strictObject({
  display_name: z.string().max(40).nullable(),
  ui_locale: z.enum(['zh-CN', 'ko-KR']),
  tz_mode: z.enum(['device', 'fixed']),
});

const source = z.enum(['page', 'chat', 'voice', 'import']);

/** 有时刻就必须有时区（events） */
function tzWithTime(r: Readonly<Record<string, unknown>>): boolean {
  return r['time'] === null || r['tz'] !== null;
}
/** 有截止时刻就必须有截止日期（todos） */
function dueWithDueTime(r: Readonly<Record<string, unknown>>): boolean {
  return r['due_time'] === null || r['due'] !== null;
}
const shortBy = z.enum(['ai', 'user']).nullable();

/** events 的客户端可写列（附录 A） */
export const eventsWrite = z
  .strictObject({
    id: uuid,
    title: z.string().min(1).max(160),
    date: dateStr,
    time: hm.nullable(),
    tz: z.string().min(1).nullable(),
    duration_min: z.number().int().min(1).max(1440),
    project: z.string().max(40),
    note: z.string().max(2000),
    source,
    raw_text: z.string().max(2000),
    location: z.string().max(200),
    short: z.string().max(32).nullable(),
    short_by: shortBy,
    push_show_title: z.boolean().nullable(),
    batch_id: uuid.nullable(),
    remind_min: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60), z.literal(1440)]).nullable(),
    remind_days: z.union([z.literal(0), z.literal(1)]).nullable(),
    notified_for: epochMs.nullable(),
    snooze_at: epochMs.nullable(),
    deleted_at: epochMs.nullable(),
    undone: z.boolean(),
    created_at: epochMs,
    updated_at: epochMs,
  })
  // 有时刻就必须有时区（附录 A 的 check）
  .refine(tzWithTime, { message: 'tz_required_with_time', path: ['tz'] });

/** todos 的客户端可写列（附录 A） */
export const todosWrite = z.strictObject({
  id: uuid,
  title: z.string().min(1).max(160),
  done: z.boolean(),
  due: dateStr.nullable(),
  important: z.boolean(),
  project: z.string().max(40),
  note: z.string().max(2000),
  source,
  raw_text: z.string().max(2000),
  batch_id: uuid.nullable(),
  from_note_id: uuid.nullable(),
  from_anniv_id: uuid.nullable(),
  short: z.string().max(32).nullable(),
  short_by: shortBy,
  done_at: epochMs,
  remind_days: z.union([z.literal(0), z.literal(1)]).nullable(),
  remind_time: hm,
  // 截止时刻（浮动时刻）和截止前多少分钟提醒（0.29 续第 124 条，R-183）
  due_time: hm.nullable(),
  remind_before_min: z.union([z.literal(0), z.literal(10), z.literal(30), z.literal(60), z.literal(120), z.literal(1440)]).nullable(),
  push_show_title: z.boolean().nullable(),
  notified_for: epochMs.nullable(),
  snooze_at: epochMs.nullable(),
  deleted_at: epochMs.nullable(),
  undone: z.boolean(),
  created_at: epochMs,
  updated_at: epochMs,
})
  // 有截止时刻就必须有截止日期（0002 的 check）
  .refine(dueWithDueTime, { message: 'due_required_with_due_time', path: ['due'] });

/** devices 的客户端可写列（0001：platform、install_id 只在 insert 时写） */
export const devicesWrite = z.strictObject({
  id: uuid,
  label: z.string().max(80).nullable(),
  platform: z.enum(['ios', 'windows', 'web', 'tauri']),
  app_version: z.string().max(40).nullable(),
  last_seen_at: z.iso.datetime({ offset: true }).nullable(),
  install_id: uuid.nullable(),
  deleted_at: epochMs.nullable(),
  undone: z.boolean(),
});

/** 表名 → 严格版 schema（insert 和 update 可写列的并集）；outbox 入队前按动作用 insertSchema / patchSchema */
export const rowsWrite = {
  profiles: profilesWrite,
  events: eventsWrite,
  todos: todosWrite,
  devices: devicesWrite,
} as const;

/**
 * 每张表 insert、update 各能写哪些列（和 0001、0002 的列级授权一致，数据清单的 insertOnly、updateOnly 同义）。
 * insert: false 的表客户端不能 insert（profiles 由注册时的触发器建）
 */
export const WRITE_RULES = {
  profiles: { insert: false, insertOnly: [], updateOnly: ['display_name', 'ui_locale', 'tz_mode'] },
  events: { insert: true, insertOnly: ['id', 'created_at'], updateOnly: ['deleted_at', 'undone'] },
  todos: { insert: true, insertOnly: ['id', 'created_at'], updateOnly: ['deleted_at', 'undone'] },
  devices: { insert: true, insertOnly: ['id', 'platform', 'install_id'], updateOnly: ['deleted_at', 'undone'] },
} as const satisfies Record<keyof typeof rowsWrite, { insert: boolean; insertOnly: readonly string[]; updateOnly: readonly string[] }>;

export type WritableTable = keyof typeof rowsWrite;
export type EventWrite = z.infer<typeof eventsWrite>;
export type TodoWrite = z.infer<typeof todosWrite>;
export type ProfileWrite = z.infer<typeof profilesWrite>;

export type DeviceWrite = z.infer<typeof devicesWrite>;

function shapeWithout(table: WritableTable, drop: readonly string[]): z.core.$ZodLooseShape {
  return Object.fromEntries(Object.entries(rowsWrite[table].shape).filter(([k]) => !drop.includes(k)));
}

/** insert 用：整行，去掉只能 update 的列（deleted_at、undone）；跨列约束照样查。profiles 不能 insert，调用直接报错 */
export function insertSchema(table: WritableTable) {
  const rule = WRITE_RULES[table];
  if (!rule.insert) throw new Error(`insert_not_allowed:${table}`);
  const base = z.strictObject(shapeWithout(table, rule.updateOnly));
  if (table === 'events') return base.refine(tzWithTime, { message: 'tz_required_with_time', path: ['tz'] });
  if (table === 'todos') return base.refine(dueWithDueTime, { message: 'due_required_with_due_time', path: ['due'] });
  return base;
}

/** patch 只校验带上的列：去掉只能 insert 的列（id、created_at、devices.platform …），仍然不准出现多余的列 */
export function patchSchema(table: WritableTable) {
  // 跨列的约束（时刻配时区、截止时刻配日期）要看整行，patch 里只带一部分列，由数据库的 check 兜底
  return z.strictObject(shapeWithout(table, WRITE_RULES[table].insertOnly)).partial();
}
