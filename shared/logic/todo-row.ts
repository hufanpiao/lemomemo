// 新建一条待办的整行（insert 要整行可写列；shared/schema/rows.ts 的 todosWrite 去掉只能 update 的 deleted_at、undone）：只有这一份。
// todos 表加了客户端可写列，只改这里（和 rows.ts 的 todosWrite）。四处新建都经它：
//   • 待办编辑页新建（features/todos/data/todo-edit.ts 的 newTodoRow：表单整份传进来）；
//   • 纪念日提醒“生成待办”（features/reminders/data/remind-write.ts 的 annivTodoRow：带 from_anniv_id）；
//   • “＋”识别（shared/logic/capture-map.ts 的 captureRow，客户端和 claude-intake 共用：带 source、raw_text、batch_id、AI 简称）；
//   • 随手记转待办（shared/logic/notes/note-convert.ts 经 captureRow，再盖上 from_note_id）。
// 没传的列按“空”：没截止、没截止时刻、不提醒提前量、优先级中、没项目备注、没批次、没来源、没简称；不带排序值（sort_key 列还在，R-442 去掉待办拖动以后前端不再读写）；remind_time 默认 DEFAULT_REMIND_TIME。
// remind_days 必须由调用方给（编辑页、生成待办是 0 当天，“＋”和随手记是 null 不提醒，两边本来就不同）。
// 不写 ai_status（系统列）、deleted_at、undone（只能 update）、repeat（R-163）。done_at 跟 done：完成的记 now，没完成 0。纯函数，不读时钟
// 读一行（todoOf）和“逾期”规则（isLate）也只有这一份（B6 整合）：待办页的分组和截止标签（features/todos/data/todo-list.ts）、
// 今天页的“没赶上”和今天截止（features/today/data/today-model.ts）都经它
// 同一组里待办的先后（compareTodos，R-442）也只有这一份：待办页各组（features/todos/data/todo-list.ts）、今天页“没赶上”和“今天的安排”（today-model.ts）、
// 日历日清单的待办组（features/todos/ui/DayTodos.tsx）都经它
// 子任务一行属于哪条待办（subOwner）、每条待办的子任务做了几项（subProgress）也在这里（11-17）：待办那一包的 todo-items.ts 读子任务、
// 今天页首屏画方框进度和“大半 3/4”都经它（今天页引不到待办那一包）
// 读数字列的 numOr 也在这里（审查 11-15 第 8 条：待办几处各写一份 num 合成这一个）：core/todo-done.ts、待办的 todo-actions、todo-autodel、todo-items、todo-list 共用
import { diffDays, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { isLiveRow } from './live-row.ts';
import { DEFAULT_REMIND_TIME } from './remind.ts';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 优先级三档（R-434，迁移 20261115100000_todos_priority.sql 的 todos_priority_in）：高、中、低；新建默认中 */
export const PRIORITIES = ['high', 'mid', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 读一行的优先级：priority 是三档之一就用它；本机缓存里还没拉到 priority 的老行按 important 推（true 高，其余中，同迁移的回填） */
export function priorityOf(r: Readonly<Record<string, unknown>>): Priority {
  const p = r['priority'];
  return PRIORITIES.includes(p as Priority) ? (p as Priority) : r['important'] === true ? 'high' : 'mid';
}

/** 行右边 H / M / L 点一下换下一档：高 → 中 → 低 → 高 */
export function nextPriority(p: Priority): Priority {
  return p === 'high' ? 'mid' : p === 'mid' ? 'low' : 'high';
}

/** 写优先级的两列（双写，TC-B0-57“先加新列、双写、下一版再删”）：priority 之外把旧列 important 写成“是不是高”，旧版客户端读到的不走样 */
export function prioCols(p: Priority): { priority: Priority; important: boolean } {
  return { priority: p, important: p === 'high' };
}

/** 读一个数字列：是有限的数就用它，不然用 d（各处原来的默认值由调用方传：0 或 null） */
export function numOr<D>(v: unknown, d: D): number | D {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** 读出来的待办（列表要的几列）：不是字符串的当空；截止日不是 YYYY-MM-DD、截止时刻不是 HH:MM 的当没有，没截止日时截止时刻也当没有 */
export interface TodoFields {
  id: string;
  title: string;
  project: string;
  done: boolean;
  priority: Priority;
  due: DateStr | null;
  dueTime: string | null;
  /** 创建时刻（epoch ms）；没有、坏了当 0 */
  createdAt: number;
}

export function todoOf(r: Readonly<{ id: string } & Record<string, unknown>>): TodoFields {
  const due = str(r['due']);
  const dt = str(r['due_time']);
  const d = DATE.test(due) ? due : null;
  return { id: r.id, title: str(r['title']), project: str(r['project']), done: r['done'] === true, priority: priorityOf(r), due: d, dueTime: d && HM.test(dt) ? dt : null, createdAt: numOr(r['created_at'], 0) };
}

/**
 * 同一组里待办的先后（R-442 负责人“只用 HML 来排序”，取代 R-429 的拖动排序）：
 * 优先级 高 → 中 → 低；同档按截止（日期早的在前；同一天有截止时刻的按时刻，没有时刻的排在有时刻的后面；没截止日的最后）；
 * 再按创建时间（早建的在前）；最后按 id，顺序稳定。“已完成”怎么排由调用方定（待办页按完成时刻）
 */
export function compareTodos(a: Pick<TodoFields, 'id' | 'priority' | 'due' | 'dueTime' | 'createdAt'>, b: Pick<TodoFields, 'id' | 'priority' | 'due' | 'dueTime' | 'createdAt'>): number {
  return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
    || (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99')
    || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99')
    || a.createdAt - b.createdAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 逾期（待办页标红“逾 N 天”“已过 17:00”、今天页“没赶上”）：没完成，截止日早于今天，或今天截止、截止时刻已过。
 *  待办截止是浮动的（架构 4.6），一律按 current_tz 判断；逾几天由调用方用 diffDays(due, 今天) 算（今天截止、时刻已过是 0） */
export function isLate(t: Pick<TodoFields, 'done' | 'due' | 'dueTime'>, now: number, tz: Tz): boolean {
  if (t.done || !t.due) return false;
  const d = diffDays(t.due, todayOf(now, tz));
  return d > 0 || (d === 0 && t.dueTime !== null && msAt(t.due, parseHm(t.dueTime), tz) <= now);
}

/** 子任务表（todo_items）的一行属于哪条待办：删了、撤销了、没有 todo_id 的返回 null */
export function subOwner(r: Readonly<Record<string, unknown>>): string | null {
  const id = r['todo_id'];
  return typeof id === 'string' && isLiveRow(r) ? id : null;
}

/** 每条待办的子任务做了几项、共几项（没有子任务的不在里面） */
export function subProgress(rows: readonly Readonly<Record<string, unknown>>[]): ReadonlyMap<string, { done: number; total: number }> {
  const m = new Map<string, { done: number; total: number }>();
  for (const r of rows) {
    const id = subOwner(r);
    if (id === null) continue;
    const c = m.get(id) ?? { done: 0, total: 0 };
    m.set(id, { done: c.done + (r['done'] === true ? 1 : 0), total: c.total + 1 });
  }
  return m;
}

/** 新建的待办整行（列和 todosWrite 去掉 deleted_at、undone 一致）；用 type 不用 interface：写入口要的是 Record<string, unknown> */
export type NewTodoRow = {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  important: boolean;
  due: DateStr | null;
  due_time: string | null;
  remind_before_min: number | null;
  remind_days: 0 | 1 | null;
  remind_time: string;
  project: string;
  note: string;
  source: 'page' | 'voice' | 'chat';
  raw_text: string;
  batch_id: string | null;
  from_note_id: string | null;
  from_anniv_id: string | null;
  short: string | null;
  short_by: 'ai' | null;
  done_at: number;
  push_show_title: null;
  notified_for: null;
  snooze_at: null;
  created_at: number;
  updated_at: number;
};

/** todoRowOf 的入参：id、title、now、remind_days 必填，其余没传按文件头的“空” */
export type TodoRowInput = Pick<NewTodoRow, 'id' | 'title' | 'remind_days'> & {
  now: number;
} & Partial<Pick<NewTodoRow,
  'done' | 'priority' | 'due' | 'due_time' | 'remind_before_min' | 'remind_time' | 'project' | 'note'
  | 'source' | 'raw_text' | 'batch_id' | 'from_note_id' | 'from_anniv_id' | 'short' | 'short_by'>>;

/** 新建一条待办的整行（规则见文件头）；标题、项目、备注的截短由调用方做 */
export function todoRowOf(i: TodoRowInput): NewTodoRow {
  const done = i.done ?? false;
  return {
    id: i.id, title: i.title, done, ...prioCols(i.priority ?? 'mid'), due: i.due ?? null, due_time: i.due_time ?? null,
    remind_before_min: i.remind_before_min ?? null, remind_days: i.remind_days, remind_time: i.remind_time ?? DEFAULT_REMIND_TIME,
    project: i.project ?? '', note: i.note ?? '', source: i.source ?? 'page', raw_text: i.raw_text ?? '', batch_id: i.batch_id ?? null,
    from_note_id: i.from_note_id ?? null, from_anniv_id: i.from_anniv_id ?? null, short: i.short ?? null, short_by: i.short_by ?? null,
    done_at: done ? i.now : 0, push_show_title: null, notified_for: null, snooze_at: null, created_at: i.now, updated_at: i.now,
  };
}
