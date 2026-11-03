// 待办列表的分组和截止标签（B2 FA-2；定稿线框 s6；R-134、R-136 字重另由样式管）
// 纯函数：行、now、current_tz 由调用方给。待办截止是浮动的（架构 4.6），一律按 current_tz 判断
// • 分组顺序：过期 → 今天 → 明天 → 7 天内（按日期各一组）→ 以后 → 没日期 → 已完成（最近完成的在前）
// • 过期：截止日早于今天，或今天的截止时刻已过（界面标红：“逾 N 天”“已过 17:00”）
// • 项目筛选只在待办页（架构 5.9“项目筛选”）：project 为 null 是“全部”
import { addDays, diffDays, msAt, parseHm, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/calendar/cal-items.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface TodoItem {
  id: string;
  title: string;
  project: string;
  done: boolean;
  important: boolean;
  due: DateStr | null;
  dueTime: string | null;
  doneAt: number;
}

/** 截止标签：界面按 kind 拼文字（“今天 17:00 截止”“逾 2 天”） */
export type DueTag =
  | { kind: 'none' }
  | { kind: 'late'; days: number; dueTime: string | null }
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
  const due = typeof r['due'] === 'string' && DATE.test(r['due']) ? r['due'] : null;
  const dt = r['due_time'];
  return {
    id: r.id, title: typeof r['title'] === 'string' ? r['title'] : '', project: typeof r['project'] === 'string' ? r['project'] : '',
    done: r['done'] === true, important: r['important'] === true, due, dueTime: due && typeof dt === 'string' && HM.test(dt) ? dt : null,
    doneAt: typeof r['done_at'] === 'number' ? r['done_at'] : 0,
  };
}

/**
 * 还在用的行：没删、没被撤销——判断只留一份，用 shared/logic/calendar 的 isLiveRow（前端 B 日历审查建议 1）。
 * 本机缓存的行列都是 unknown，对不上它的入参类型，这里断言一次；运行时它只看 deleted_at ?? null 和 undone !== true，
 * 任何值都一样（同一组输入的对照测试在本功能的 __tests__/live-row.test.ts）
 */
export const isLive = (r: Row): boolean => isLiveRow(r as Parameters<typeof isLiveRow>[0]);

export function dueTagOf(t: TodoItem, now: number, tz: Tz): DueTag {
  if (!t.due) return { kind: 'none' };
  const today = todayOf(now, tz);
  const d = diffDays(t.due, today);
  if (!t.done) {
    if (d > 0) return { kind: 'late', days: d, dueTime: t.dueTime };
    if (d === 0 && t.dueTime && msAt(t.due, parseHm(t.dueTime), tz) <= now) return { kind: 'late', days: 0, dueTime: t.dueTime };
  }
  if (d === 0) return { kind: 'today', dueTime: t.dueTime };
  if (d === -1) return { kind: 'tomorrow', dueTime: t.dueTime };
  return { kind: 'date', date: t.due, dueTime: t.dueTime };
}

const byDue = (a: TodoItem, b: TodoItem) =>
  (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || Number(b.important) - Number(a.important) || a.title.localeCompare(b.title);

/** 待办页的分组；空组不出现。project 不为 null 时只留这个项目的 */
export function groupTodos(rows: readonly Row[], now: number, tz: Tz, project: string | null = null): Group[] {
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
    if (!isLive(r)) continue;
    const t = itemOf(r);
    if (project !== null && t.project !== project) continue;
    const tag = dueTagOf(t, now, tz);
    if (t.done) put('done', null, t, tag);
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
    else if (g.key === 'nodate') g.items.sort((a, b) => Number(b.todo.important) - Number(a.todo.important) || a.todo.title.localeCompare(b.todo.title));
    else g.items.sort((a, b) => byDue(a.todo, b.todo));
  }
  return out;
}

/** 项目筛选条：“全部”之外的项目和各自没完成的条数（按条数多的在前） */
export function projectCounts(rows: readonly Row[]): { project: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!isLive(r)) continue;
    const t = itemOf(r);
    if (t.done || t.project === '') continue;
    m.set(t.project, (m.get(t.project) ?? 0) + 1);
  }
  return [...m].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
}
