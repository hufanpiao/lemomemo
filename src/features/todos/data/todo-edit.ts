// 待办编辑页的数据逻辑（B2 任务单 FA-2；架构 0.29 续第 124 条③、第 136 条，R-183；TC-B2-01、74）
// • 表单 ↔ 行：formOf 从集合里的行取编辑页要的字段；newTodoRow 造新建的整行（insert 要整行可写列）
// • 改了什么就只写什么（patchOf）：比较前后两份表单，只放变了的列，外加 updated_at；规则：
//   ① 清掉截止日期：同一个 patch 里把 due_time、remind_before_min 一起清掉（第 136 条：库的约束要求有截止时刻必须有日期）；
//   ② 第一次设截止时刻（原来没有）：提前量默认 60（shared 的 remindBeforeOnSetDueTime，和 BE-4 同一份）；原来就有的保留；
//   ③ 清掉截止时刻：提前量一并清掉，回到原来的“当天 / 前一天 + 时刻”（remind_days、remind_time 不动）；
//   ④ 改了标题且简称是 AI 起的（short_by = 'ai'）：同一个 patch 里清掉 short、short_by（架构 5.12 L3）
//   ⑤ R-375（11-10 负责人）：没有截止日期时改了提醒（当天 / 前一天、提醒时刻），截止日期自动填今天（按 current_tz，由调用方传 today），可以再改；
//      改成“不提醒”不填（没要提醒，不替用户定截止）；已有截止日期不动。填了今天以后提醒时刻可能已经过了（“前一天”、或今天的时刻已过）：
//      照样存，不挪日子；编辑页用 remindPassed 在提醒那一行下面出灰字“这个提醒时刻已经过了”，用户自己改
// • 带不带提醒（写入的 remind 标记，outbox 据此整条提前发）：用 shared/logic/remind.ts 的 remindAtOf 本机现算，和服务器同一份
// • R-415 ①：随手记转来的待办（from_note_id）在最后一组出“来源 随手记 · 标题 ›”，显示规则在 sourceOf
// 纯 TS：不准 import React（A1）
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { noteHeadline } from '../../../../shared/logic/notes/note-headline.ts';
import { trimItemTitle } from '../../../../shared/schema/rows.ts';
import { DEFAULT_TODO_REMIND_TIME, REMIND_BEFORE_CHOICES, remindBeforeOnSetDueTime, todoRemindAt } from '../../../../shared/logic/remind.ts';
import { todoRemindFlag } from '../../../core/remind-flag.ts';

/** 编辑页能改的字段 */
export interface TodoForm {
  title: string;
  done: boolean;
  important: boolean;
  due: DateStr | null;
  due_time: string | null;
  /** 有截止时刻时才用；null = 不提醒 */
  remind_before_min: number | null;
  /** 没有截止时刻时：0 当天 / 1 前一天 / null 不提醒 */
  remind_days: 0 | 1 | null;
  remind_time: string;
  project: string;
  note: string;
}

/** “提前提醒”的选项：不提醒（null）放最前，其余照 shared 的表（TC-B2-74：不提醒 / 准时 / 10 分钟 / 30 分钟 / 1 小时 / 2 小时 / 1 天） */
export const REMIND_BEFORE_OPTIONS: readonly (number | null)[] = [null, ...REMIND_BEFORE_CHOICES];

export { ITEM_TITLE_MAX, PROJECT_MAX, ITEM_NOTE_MAX as NOTE_MAX } from '../../../../shared/schema/rows.ts';

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const days = (v: unknown): 0 | 1 | null => (v === 0 || v === 1 ? v : null);
const before = (v: unknown): number | null => (typeof v === 'number' && REMIND_BEFORE_CHOICES.includes(v) ? v : null);

/** 集合里的一行 → 表单（缺的、类型不对的按默认值，宽容读取已保证大体形状） */
export function formOf(row: Readonly<Record<string, unknown>>): TodoForm {
  return {
    title: str(row['title']),
    done: row['done'] === true,
    important: row['important'] === true,
    due: strOrNull(row['due']),
    due_time: strOrNull(row['due_time']),
    remind_before_min: before(row['remind_before_min']),
    remind_days: days(row['remind_days']),
    remind_time: str(row['remind_time'], DEFAULT_TODO_REMIND_TIME) || DEFAULT_TODO_REMIND_TIME,
    project: str(row['project']),
    note: str(row['note']),
  };
}

/** 新建时的表单：没有截止日、当天 9:00 提醒（要设了截止日才生效） */
export function emptyForm(): TodoForm {
  return {
    title: '', done: false, important: false, due: null, due_time: null, remind_before_min: null,
    remind_days: 0, remind_time: DEFAULT_TODO_REMIND_TIME, project: '', note: '',
  };
}

/** 截止日期、截止时刻改了以后把连带的字段一起改好（规则 ①②③⑤）。界面每次改这几个字段都过一遍它；today 给了才做 ⑤ */
export function normalize(prev: TodoForm, next: TodoForm, today?: DateStr): TodoForm {
  const out = { ...next };
  const remindChanged = next.remind_days !== prev.remind_days || next.remind_time !== prev.remind_time;
  if (today !== undefined && prev.due === null && out.due === null && out.remind_days !== null && remindChanged) {
    // ⑤ R-375：没设截止就改了提醒 → 截止日填今天
    out.due = today;
  }
  if (out.due === null) {
    // ①：没有日期就不能有截止时刻
    out.due_time = null;
    out.remind_before_min = null;
    return out;
  }
  if (out.due_time === null) {
    // ③
    out.remind_before_min = null;
  } else if (prev.due_time === null && next.remind_before_min === prev.remind_before_min) {
    // ②：第一次设截止时刻，提前量没被同时改过时用默认
    out.remind_before_min = remindBeforeOnSetDueTime(prev.due_time, prev.remind_before_min);
  }
  return out;
}

/** “当天 / 前一天 + 提醒时刻”算出来的提醒时刻已经过了（R-375 自动填了今天以后最常见）：编辑页出灰字。没设截止、用截止时刻提醒的不管 */
export function remindPassed(form: TodoForm, tz: Tz, now: number): boolean {
  if (form.due === null || form.due_time !== null || form.remind_days === null || form.done) return false;
  const at = todoRemindAt(form, tz, now);
  return at !== null && at < now;
}


const FIELDS: readonly (keyof TodoForm)[] = [
  'title', 'done', 'important', 'due', 'due_time', 'remind_before_min', 'remind_days', 'remind_time', 'project', 'note',
];

/** 前后两份表单 → patch（只放变了的列）；没变返回 null。row 是集合里的原行（看 short_by） */
export function patchOf(
  row: Readonly<Record<string, unknown>>,
  prev: TodoForm,
  next: TodoForm,
  now: number,
): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const k of FIELDS) if (next[k] !== prev[k]) data[k] = next[k];
  if (Object.keys(data).length === 0) return null;
  if ('title' in data && row['short_by'] === 'ai') {
    data['short'] = null;
    data['short_by'] = null;
  }
  if ('done' in data) data['done_at'] = next.done ? now : 0;
  data['updated_at'] = now;
  return data;
}

/** 新建的整行（insert 要整行可写列；deleted_at、undone 只能 update，不放） */
export function newTodoRow(id: string, form: TodoForm, now: number): Record<string, unknown> & { id: string } {
  return {
    id, ...form, title: trimItemTitle(form.title), source: 'page', raw_text: '', batch_id: null, from_note_id: null, from_anniv_id: null,
    short: null, short_by: null, done_at: form.done ? now : 0, push_show_title: null, notified_for: null, snooze_at: null,
    created_at: now, updated_at: now,
  };
}

/**
 * 决定“回落到截止时刻”的列（shared/logic/remind.ts 文件头 ①：新建、改了截止日期 / 截止时刻 / 提前量时不传 prevRemindAt）。
 * 一个 patch 里只要含其中一列就不传（代码审查补审表最后一行）
 */
export const TODO_TIMING_COLS: readonly string[] = ['due', 'due_time', 'remind_before_min'];

type RowLike = Readonly<Record<string, unknown>> | undefined;
const remindAtCol = (row: RowLike): number | null => (typeof row?.['remind_at'] === 'number' ? row['remind_at'] : null);
const isDel = (v: unknown): boolean => v !== null && v !== undefined;

/**
 * 这次保存给 remindAtOf 的 prevRemindAt（B2 任务单“接口先定”第 4 条、架构 0.54 第 2 条）：
 * 新建（data 为 null）、改了 TODO_TIMING_COLS 里的列 → undefined（不传）；其余 → 这一行现在的 remind_at（本机新建、还没同步回来的行没有这一列，按 null）
 */
export function prevRemindAtOf(row: RowLike, data: Readonly<Record<string, unknown>> | null): number | null | undefined {
  if (data === null || row === undefined) return undefined;
  if (TODO_TIMING_COLS.some((c) => c in data)) return undefined;
  return remindAtCol(row);
}

/**
 * 写入的 remind 标记（outbox 据此整条提前发）：规则在 core/remind-flag.ts（代码审查 S2、S14～S16）——改之后算得出、且不早于 now − 2 分钟的提醒时刻，
 * 或者改之前还会响（按字段重算的、服务器上的 remind_at、snooze_at 任一个不早于 now − 2 分钟；撤掉提醒的写入也要尽快上服务器）。
 * 删除 / 恢复也走这里（data 里带 deleted_at）
 */
export function hasRemind(c: { row: RowLike; data: Readonly<Record<string, unknown>> | null; prev: TodoForm | null; next: TodoForm; tz: Tz; now: number }): boolean {
  const delAfter = c.data && 'deleted_at' in c.data ? isDel(c.data['deleted_at']) : isDel(c.row?.['deleted_at']);
  // 改之前那一份按“其余重算”传它自己的 remind_at；已经过了的提醒不用撤（补审第 5 条：提前时刻、截止都过了时改截止时刻标记为 false）
  return todoRemindFlag({
    row: c.prev === null ? undefined : c.row,
    after: { ...c.next, deleted_at: delAfter ? 1 : null },
    prevRemindAt: prevRemindAtOf(c.row, c.data),
    before: c.prev ? { ...c.prev, deleted_at: null } : undefined,
    now: c.now,
    tz: c.tz,
  });
}

/** “来源”行要的：那条随手记的 id、显示标题，gone = 删了（在“最近删除”里） */
export interface TodoSource {
  id: string;
  title: string;
  gone: boolean;
}

/**
 * 待办编辑页的“来源”行（R-415 ①）：note 是 from_note_id 指的那条随手记（本机集合里的行，本机没有为 undefined）。
 * • 本机没有、撤销了的（undone）、隐私记（is_private，B5）→ null，不出这一行（隐私记的标题不露在待办页）；
 * • 删了的（在“最近删除”里；不带图的随手记转完原条就在这里）→ gone：这一行变灰、不能点，下面一行灰字说明；
 * • 其余能点，打开那条随手记。标题取法同随手记列表（shared 的 noteHeadline：没有标题取正文第一行）
 */
export function sourceOf(note: RowLike): TodoSource | null {
  const id = note?.['id'];
  if (note === undefined || typeof id !== 'string' || note['undone'] === true || note['is_private'] === true) return null;
  return { id, title: noteHeadline(note['title'], note['body']).title, gone: isDel(note['deleted_at']) };
}
