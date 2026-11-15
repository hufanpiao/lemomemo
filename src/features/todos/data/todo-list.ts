// 待办列表的分组和截止标签（B2 FA-2；定稿线框 s6；R-134、R-136 字重另由样式管）
// 纯函数：行、now、current_tz 由调用方给。待办截止是浮动的（架构 4.6），一律按 current_tz 判断
// • 分组顺序：过期 → 今天 → 明天 → 7 天内（按日期各一组）→ 以后 → 没日期 → 已完成（最近完成的在前）
// • 过期：截止日早于今天，或今天的截止时刻已过（界面标红：“逾 N 天”“已过 17:00”）；规则和读一行都在 shared/logic/todo-row.ts（和今天页共用）
// • 项目筛选只在待办页（架构 5.9“项目筛选”）：project 为 null 是“全部”
// • linger（负责人 11-15“完成的待办怎么隐藏”；审查 11-15 第 4 条改成集合）：撤销条开着期间勾过的那几条，照没完成时的截止分组留在原位，
//   撤销条都收起以后才一起归进“已完成”组（谁在 linger 里由待办页管，见 ui/TodosPage.tsx）
import { addDays, diffDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { isLate, numOr, PRIORITIES, todoOf, type TodoFields } from '../../../../shared/logic/todo-row.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
// 标题比较：按当前语言、数字按数值（“第 2 条”在“第 10 条”前；和今天页共用）
import { titleCompare } from '../../../../shared/i18n/title-compare.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

export interface TodoItem extends TodoFields {
  doneAt: number;
}

/** 截止标签：界面按 kind 拼文字（“今天 17:00 截止”“逾 2 天”） */
export type DueTag =
  | { kind: 'none' }
  | { kind: 'late'; days: number; due: DateStr; dueTime: string | null }
  | { kind: 'today'; dueTime: string | null }
  | { kind: 'tomorrow'; dueTime: string | null }
  | { kind: 'date'; date: DateStr; dueTime: string | null };

export type GroupKey = 'late' | 'today' | 'tomorrow' | 'day' | 'later' | 'nodate' | 'done';

export interface Group {
  key: GroupKey;
  /** key 为 'day' 时是那一天 */
  date: DateStr | null;
  items: { todo: TodoItem; tag: DueTag }[];
}

export function itemOf(r: Row): TodoItem {
  return { ...todoOf(r), doneAt: numOr(r['done_at'], 0) };
}

export function dueTagOf(t: TodoItem, now: number, tz: Tz): DueTag {
  if (!t.due) return { kind: 'none' };
  const d = diffDays(t.due, todayOf(now, tz));
  if (isLate(t, now, tz)) return { kind: 'late', days: d, due: t.due, dueTime: t.dueTime };
  if (d === 0) return { kind: 'today', dueTime: t.dueTime };
  if (d === -1) return { kind: 'tomorrow', dueTime: t.dueTime };
  return { kind: 'date', date: t.due, dueTime: t.dueTime };
}

const NO_LINGER: ReadonlySet<string> = new Set();

/** 优先级高的在前（R-434：高 → 中 → 低，替掉原来的“重要的在前”） */
const byPrio = (a: TodoItem, b: TodoItem) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);

const byDue = (byTitle: (a: string, b: string) => number) => (a: TodoItem, b: TodoItem) =>
  (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || byPrio(a, b) || byTitle(a.title, b.title);

/** 待办页的分组；空组不出现。project 不为 null 时只留这个项目的 */
/** locale：同一截止时刻、没日期那组按标题排时用哪种语言比（数字按数值）；linger：已完成但先留在原组的那几条 id */
export function groupTodos(rows: readonly Row[], now: number, tz: Tz, project: string | null = null, locale: Locale = 'zh-CN', linger: ReadonlySet<string> = NO_LINGER): Group[] {
  const byTitle = titleCompare(locale);
  const due = byDue(byTitle);
  const today = todayOf(now, tz);
  const week = addDays(today, 7);
  const groups = new Map<string, Group>();
  const put = (key: GroupKey, date: DateStr | null, todo: TodoItem, tag: DueTag) => {
    const k = `${key}:${date ?? ''}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key, date, items: [] }));
    g.items.push({ todo, tag });
  };
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const t = itemOf(r);
    if (project !== null && t.project !== project) continue;
    const tag = dueTagOf(t, now, tz);
    if (t.done && !linger.has(t.id)) put('done', null, t, tag);
    else if (tag.kind === 'late') put('late', null, t, tag);
    else if (tag.kind === 'today') put('today', null, t, tag);
    else if (tag.kind === 'tomorrow') put('tomorrow', null, t, tag);
    else if (tag.kind === 'none') put('nodate', null, t, tag);
    else if (tag.date < week) put('day', tag.date, t, tag);
    else put('later', null, t, tag);
  }
  const order: GroupKey[] = ['late', 'today', 'tomorrow', 'day', 'later', 'nodate', 'done'];
  const out = [...groups.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key) || (a.date ?? '').localeCompare(b.date ?? ''));
  for (const g of out) {
    if (g.key === 'done') g.items.sort((a, b) => b.todo.doneAt - a.todo.doneAt);
    else if (g.key === 'nodate') g.items.sort((a, b) => byPrio(a.todo, b.todo) || byTitle(a.todo.title, b.todo.title));
    else g.items.sort((a, b) => due(a.todo, b.todo));
  }
  return out;
}

/** 项目筛选条：“全部”之外的项目和各自的条数（含已完成，R-436 确认图）（按条数多的在前；条数一样按项目名，按当前语言、数字按数值，和标题同一个比较） */
export function projectCounts(rows: readonly Row[], locale: Locale = 'zh-CN'): { project: string; count: number }[] {
  const byName = titleCompare(locale);
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const t = itemOf(r);
    if (t.project === '') continue;   // 含已完成（R-436 第 3 条确认图“全部 10”和“1 / 10 完成”同一个口径）
    m.set(t.project, (m.get(t.project) ?? 0) + 1);
  }
  return [...m].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count || byName(a.project, b.project));
}
