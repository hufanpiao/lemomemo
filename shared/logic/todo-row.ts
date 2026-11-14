// 新建一条待办的整行（insert 要整行可写列；shared/schema/rows.ts 的 todosWrite 去掉只能 update 的 deleted_at、undone）：只有这一份。
// todos 表加了客户端可写列，只改这里（和 rows.ts 的 todosWrite）。四处新建都经它：
//   • 待办编辑页新建（features/todos/data/todo-edit.ts 的 newTodoRow：表单整份传进来）；
//   • 纪念日提醒“生成待办”（features/reminders/data/remind-write.ts 的 annivTodoRow：带 from_anniv_id）；
//   • “＋”识别（shared/logic/capture-map.ts 的 captureRow，客户端和 claude-intake 共用：带 source、raw_text、batch_id、AI 简称）；
//   • 随手记转待办（shared/logic/notes/note-convert.ts 经 captureRow，再盖上 from_note_id）。
// 没传的列按“空”：没截止、没截止时刻、不提醒提前量、不重要、没项目备注、没批次、没来源、没简称；remind_time 默认 DEFAULT_REMIND_TIME。
// remind_days 必须由调用方给（编辑页、生成待办是 0 当天，“＋”和随手记是 null 不提醒，两边本来就不同）。
// 不写 ai_status（系统列）、deleted_at、undone（只能 update）、repeat（R-163）。done_at 跟 done：完成的记 now，没完成 0。纯函数，不读时钟
// 读一行（todoOf）和“逾期”规则（isLate）也只有这一份（B6 整合）：待办页的分组和截止标签（features/todos/data/todo-list.ts）、
// 今天页的“没赶上”和今天截止（features/today/data/today-model.ts）都经它
import { diffDays, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { DEFAULT_REMIND_TIME } from './remind.ts';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 读出来的待办（列表要的几列）：不是字符串的当空；截止日不是 YYYY-MM-DD、截止时刻不是 HH:MM 的当没有，没截止日时截止时刻也当没有 */
export interface TodoFields {
  id: string;
  title: string;
  project: string;
  done: boolean;
  important: boolean;
  due: DateStr | null;
  dueTime: string | null;
}

export function todoOf(r: Readonly<{ id: string } & Record<string, unknown>>): TodoFields {
  const due = str(r['due']);
  const dt = str(r['due_time']);
  const d = DATE.test(due) ? due : null;
  return { id: r.id, title: str(r['title']), project: str(r['project']), done: r['done'] === true, important: r['important'] === true, due: d, dueTime: d && HM.test(dt) ? dt : null };
}

/** 逾期（待办页标红“逾 N 天”“已过 17:00”、今天页“没赶上”）：没完成，截止日早于今天，或今天截止、截止时刻已过。
 *  待办截止是浮动的（架构 4.6），一律按 current_tz 判断；逾几天由调用方用 diffDays(due, 今天) 算（今天截止、时刻已过是 0） */
export function isLate(t: Pick<TodoFields, 'done' | 'due' | 'dueTime'>, now: number, tz: Tz): boolean {
  if (t.done || !t.due) return false;
  const d = diffDays(t.due, todayOf(now, tz));
  return d > 0 || (d === 0 && t.dueTime !== null && msAt(t.due, parseHm(t.dueTime), tz) <= now);
}

/** 新建的待办整行（列和 todosWrite 去掉 deleted_at、undone 一致）；用 type 不用 interface：写入口要的是 Record<string, unknown> */
export type NewTodoRow = {
  id: string;
  title: string;
  done: boolean;
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
  'done' | 'important' | 'due' | 'due_time' | 'remind_before_min' | 'remind_time' | 'project' | 'note'
  | 'source' | 'raw_text' | 'batch_id' | 'from_note_id' | 'from_anniv_id' | 'short' | 'short_by'>>;

/** 新建一条待办的整行（规则见文件头）；标题、项目、备注的截短由调用方做 */
export function todoRowOf(i: TodoRowInput): NewTodoRow {
  const done = i.done ?? false;
  return {
    id: i.id, title: i.title, done, important: i.important ?? false, due: i.due ?? null, due_time: i.due_time ?? null,
    remind_before_min: i.remind_before_min ?? null, remind_days: i.remind_days, remind_time: i.remind_time ?? DEFAULT_REMIND_TIME,
    project: i.project ?? '', note: i.note ?? '', source: i.source ?? 'page', raw_text: i.raw_text ?? '', batch_id: i.batch_id ?? null,
    from_note_id: i.from_note_id ?? null, from_anniv_id: i.from_anniv_id ?? null, short: i.short ?? null, short_by: i.short_by ?? null,
    done_at: done ? i.now : 0, push_show_title: null, notified_for: null, snooze_at: null, created_at: i.now, updated_at: i.now,
  };
}
