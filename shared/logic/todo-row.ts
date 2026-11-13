// 新建一条待办的整行（insert 要整行可写列；shared/schema/rows.ts 的 todosWrite 去掉只能 update 的 deleted_at、undone）：只有这一份。
// todos 表加了客户端可写列，只改这里（和 rows.ts 的 todosWrite）。四处新建都经它：
//   • 待办编辑页新建（features/todos/data/todo-edit.ts 的 newTodoRow：表单整份传进来）；
//   • 纪念日提醒“生成待办”（features/reminders/data/remind-write.ts 的 annivTodoRow：带 from_anniv_id）；
//   • “＋”识别（shared/logic/capture-map.ts 的 captureRow，客户端和 claude-intake 共用：带 source、raw_text、batch_id、AI 简称）；
//   • 随手记转待办（shared/logic/notes/note-convert.ts 经 captureRow，再盖上 from_note_id）。
// 没传的列按“空”：没截止、没截止时刻、不提醒提前量、不重要、没项目备注、没批次、没来源、没简称；remind_time 默认 DEFAULT_REMIND_TIME。
// remind_days 必须由调用方给（编辑页、生成待办是 0 当天，“＋”和随手记是 null 不提醒，两边本来就不同）。
// 不写 ai_status（系统列）、deleted_at、undone（只能 update）、repeat（R-163）。done_at 跟 done：完成的记 now，没完成 0。纯函数，不读时钟
import type { DateStr } from '../core/date.ts';
import { DEFAULT_REMIND_TIME } from './remind.ts';

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
