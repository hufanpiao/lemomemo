// 各表“客户端可写列”的形状（架构 2.5）：outbox 入队前用严格版校验
// B0 只做严格版：多一个列、类型不对都拒收。读网络数据用的宽容版（不认识的枚举换成 unknown 等，0.27 第 1 点）B1 再加
// 列名以 3.3 C 的列级授权和附录 A 为准；CI 比对清单、grant、apply_patch、本文件四处一致（3.5），比对脚本由后端在 B0 写
// 注意：events、todos 的可写列是按附录 A 推的，后端写完 0002 的 grant 后要按实际授权核对一遍
import { z } from 'zod';

/** 改了本文件的形状或枚举，就把它加 1（2.6：本机库按 schema_v 整表重拉） */
export const SCHEMA_V = 1;

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
    deleted_at: epochMs.nullable(),
    undone: z.boolean(),
    created_at: epochMs,
    updated_at: epochMs,
  })
  // 有时刻就必须有时区（附录 A 的 check）
  .refine((r) => r.time === null || r.tz !== null, { message: 'tz_required_with_time', path: ['tz'] });

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
  push_show_title: z.boolean().nullable(),
  deleted_at: epochMs.nullable(),
  undone: z.boolean(),
  created_at: epochMs,
  updated_at: epochMs,
});

/** 表名 → 严格版 schema；outbox 入队前按表取 */
export const rowsWrite = {
  profiles: profilesWrite,
  events: eventsWrite,
  todos: todosWrite,
} as const;

export type WritableTable = keyof typeof rowsWrite;
export type EventWrite = z.infer<typeof eventsWrite>;
export type TodoWrite = z.infer<typeof todosWrite>;
export type ProfileWrite = z.infer<typeof profilesWrite>;

/** patch 只校验带上的列：严格版的“部分”形状，仍然不准出现多余的列 */
export function patchSchema<T extends WritableTable>(table: T) {
  // zod 4 的 refine 不改变对象类型，shape 还在；跨列的 refine（时刻配时区）只在整行校验时做
  return z.strictObject(rowsWrite[table].shape).partial();
}
