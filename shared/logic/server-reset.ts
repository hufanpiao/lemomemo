// 服务器 UPDATE 触发器清系统列的规则（REMIND-shown-persist 方案修订 1 第 3 节 ③，11-05 后端）：本机确认一项改动以后（core/outbox-send.ts 的 ackImpl），
// 把“server 副本 + 这次实际落库的列”合起来时照服务器的规则先清掉旧那一次的系统列，免得在下一次拉取之前，用旧 pushed_for 误压新的那一次提醒。
// 照的是 private.touch()（R-411 迁移 20261113100000 起，原来的 events_occ_reset 前置触发器和 touch() 提醒段都收进 touch() 里调的 private.remind_reset），先后顺序：
//   ① 待办的 due 是空的，连带清 due_time、remind_before_min；
//   ② 日程的 date 变了、remind_days 变了、time 在空和非空之间变了，就是换了“哪一次”——
//      pushed_for 一律清空；notified_for 合并后的值和原来一样（补丁里没带，或显式写了原值，都算，复审 L6）就清空，改成了原来的 remind_at 也清空；
//      snooze_at 合并后的值和原来一样就清空；
//   ③ 提醒相关列（TOUCH_REMIND_COLS，真库是 table_meta.remind_cols）有一列的值变了，清 pushed_for、defer_until。
// 一律按“合并以后的值和原来的值是否不同”判断（同 SQL 的 is distinct from），不按补丁里有没有这个键；old 取合并之前的 server 副本。
// applied 只放实际落库的列：冲突确认（ack.status === 'forked'）时传 appliedColumns(sent, ack)，不传整个 sent.data（复审 L7）。
// 前提（11-05 审查 S4）：old 必须是完整的一行（拉取用 select *）；缺列时补丁把那一列写成 null 会被当作“没变”，该清的不清。
// 三方一致：supabase/tests/rls/38_server_reset_parity.test.sql 的向量在真库跑，tests/shared/server-reset.test.ts 读同一份向量跑本函数和替身 push-dispatch-mem 的 edit()。
// 不 import 任何文件（core、SW、Deno 都能引）。

type Row = Record<string, unknown>;

/** private.touch() 认的提醒相关列（三张提醒表合起来；这一行没有的列不算） */
export const TOUCH_REMIND_COLS = [
  'date', 'time', 'tz', 'due', 'due_time', 'remind_before_min', 'remind_min', 'remind_days', 'remind_time', 'remind_offsets',
  'month', 'day', 'calendar', 'lunar_variant', 'is_leap', 'year', 'after_due', 'kind', 'done', 'deleted_at',
] as const;

const REMIND_TABLES: readonly string[] = ['events', 'todos', 'anniversaries'];

const nil = (v: unknown): unknown => (v === undefined ? null : v);

/** 同 SQL 的 is not distinct from：空和没有都算 null；数组、对象按 JSON 比 */
function same(a: unknown, b: unknown): boolean {
  const x = nil(a);
  const y = nil(b);
  if (x === y) return true;
  if (typeof x === 'object' && typeof y === 'object' && x !== null && y !== null) return JSON.stringify(x) === JSON.stringify(y);
  return false;
}

/** 日程换了“哪一次”：同 events_occ_reset 的 when 条件 */
export function occurrenceChanged(old: Row, next: Row): boolean {
  return !same(old['date'], next['date']) || !same(old['remind_days'], next['remind_days']) || (nil(old['time']) === null) !== (nil(next['time']) === null);
}

/**
 * old（合并之前的 server 副本）叠上 applied（实际落库的列），再照服务器触发器清系统列，返回新的副本（不改入参）。
 * old 为空（新建）时只合并：真库 INSERT 时 touch() 不清这几列。不是三张提醒表的，只合并。
 */
export function mergeWithServerResets<T extends Row>(table: string, old: T | null, applied: Row): T {
  // 用 Map 读写（_shared/gen 里也有这一份，check_backend F7 不准拿变量当方括号键名）
  const o = new Map<string, unknown>(old === null ? [] : Object.entries(old));
  const row = new Map<string, unknown>(o);
  for (const [k, v] of Object.entries(applied)) if (v !== undefined) row.set(k, v);
  if (old === null || !REMIND_TABLES.includes(table)) return Object.fromEntries(row) as T;
  if (table === 'events' && occurrenceChanged(old, Object.fromEntries(row))) {
    const remindAt = nil(o.get('remind_at'));
    if (same(row.get('notified_for'), o.get('notified_for')) || (remindAt !== null && same(row.get('notified_for'), remindAt))) row.set('notified_for', null);
    if (same(row.get('snooze_at'), o.get('snooze_at'))) row.set('snooze_at', null);
    row.set('pushed_for', null);
  }
  if (table === 'todos' && nil(row.get('due')) === null) {
    row.set('due_time', null);
    row.set('remind_before_min', null);
  }
  if (TOUCH_REMIND_COLS.some((k) => (row.has(k) || o.has(k)) && !same(row.get(k), o.get(k)))) {
    row.set('pushed_for', null);
    row.set('defer_until', null);
  }
  return Object.fromEntries(row) as T;
}
