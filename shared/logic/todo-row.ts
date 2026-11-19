// 待办的优先级三档、读一行、逾期、组内先后（纯函数，不读时钟）。新建一条待办的整行（todoRowOf、NewTodoRow）在 todo-new.ts：
// 那边要引 remind.ts，放在这里会让今天页首屏连带下载提醒算法块（11-17 ci 首屏预算 150.2 KB 超线，拆开）
// 读一行（todoOf）和“逾期”规则（isLate）只有这一份（B6 整合）：待办页的分组和截止标签（features/todos/data/todo-list.ts）、
// 今天页的“没赶上”和今天截止（features/today/data/today-model.ts）都经它
// 同一组里待办的先后（compareTodos，R-442）也只有这一份：待办页各组（features/todos/data/todo-list.ts）、今天页“没赶上”和“今天的安排”（today-model.ts）、
// 日历日清单的待办组（features/todos/ui/DayTodos.tsx）都经它
// 子任务一行属于哪条待办（subOwner）、每条待办的子任务做了几项（subProgress）也在这里（11-17）：待办那一包的 todo-items.ts 读子任务、
// 今天页首屏画方框进度和“大半 3/4”都经它（今天页引不到待办那一包）
// 读数字列的 numOr 也在这里（审查 11-15 第 8 条：待办几处各写一份 num 合成这一个）：core/todo-done.ts、core/todo-writes.ts、待办的 todo-autodel、todo-items、todo-list 共用
// 刚勾完还留在原位的照没完成算（lingerView）也只有这一份（独立评审 11-18 二-2）
import { diffDays, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { isLiveRow } from './live-row.ts';

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

/** 刚勾完、还留在原位的（linger：kit/components/useDoneFlow.ts 的 useLinger 管谁在里面）照没完成算，收起以后才算做完。
 *  分组、逾期、排序、“已过去”一律拿它返回的那一份判断（今天页 today-model.ts、待办页 todo-list.ts、日历日清单 useDayTodos 同一个口径，
 *  独立评审 11-18 二-2：原来五处各写一份、今天页“今天的安排”漏了，今天截止已过时刻的刚勾完两组都出现）；
 *  画行、计数照旧用原来那一份（方框、划线按 done 画，计数“1 / 10 完成”算勾上的） */
export function lingerView<T extends Pick<TodoFields, 'id' | 'done'>>(t: T, linger: ReadonlySet<string>): T {
  return t.done && linger.has(t.id) ? { ...t, done: false } : t;
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
