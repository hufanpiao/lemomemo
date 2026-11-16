// 待办页长按拖动排序（R-429，主持人 11-15 定）：组内换序、拖到别的日期组改截止日期。手势和落点在 kit 的 SortDrag，这里只算“要写什么”和写。
// • 哪些组能放进去（canDropTodo）：今天、明天、7 天内的某一天（各是一个日期）；“过期”只出不进；“以后”“没日期”只能组内换序（不是一个日期）；
//   “已完成”组不能拖（行上打 data-sort-off，页面管）
// • 排序值按松手后这一组的顺序算（shared/logic/sort-key.ts 的 planMove）：邻居都拖过只写这一条，不然这一组整组重排
// • 跨组：截止日期改成那一组的日期；拖到今天、原来的截止时刻今天已经过了，去掉截止时刻（截止前提醒的提前量跟着去掉）；别的截止时刻保留
// • 撤销：每一笔都带原来的值（截止日期、截止时刻、提前量、排序值），撤销按原样写回
// • 编辑页改日期不清排序值（R-429 原文）：这里不碰编辑页
// • 写入经 core 的 edit-save（进 outbox、本机先生效）；改了截止的那一笔按提醒规则带 remind 标记，只改排序值的不带
// 纯 TS：不准 import React（A1）
import { addDays, msAt, parseHm, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { planMove } from '../../../../shared/logic/sort-key.ts';
import { savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { todoRemindFields, todoRemindFlag } from '../../../core/remind-flag.ts';
import type { Group, Row } from './todo-list.ts';

/** 页面上一组的标记（行上的 data-sort-group）：分组键 + 日期 */
export const groupId = (g: Pick<Group, 'key' | 'date'>): string => `${g.key}:${g.date ?? ''}`;

/** 能放进去的组（见文件头）：同一组里换序除了“已完成”都行 */
export function canDropTodo(from: string, to: string): boolean {
  const k = to.split(':')[0];
  if (from === to) return k !== 'done';
  return k === 'today' || k === 'tomorrow' || k === 'day';
}

/** 一组对应的截止日期（只有能跨组放进去的那几种有） */
export function dueOfGroup(g: Pick<Group, 'key' | 'date'>, today: DateStr): DateStr | null {
  if (g.key === 'today') return today;
  if (g.key === 'tomorrow') return addDays(today, 1);
  return g.key === 'day' ? g.date : null;
}

/** 一笔写入：patch 写上去，undo 撤销时写回 */
export interface TodoSortWrite {
  id: string;
  patch: Record<string, unknown>;
  undo: Record<string, unknown>;
  /** 改了截止（带 remind 标记） */
  due: boolean;
}

export interface TodoSortPlan {
  writes: TodoSortWrite[];
  /** 跨组放下时目标那一组（提示条写“已改到 X”）；组内换序为 null */
  to: Group | null;
}

/**
 * 放下以后要写的（规则见文件头）；对不上（组没了、这一条没了、不让放）回 null。
 * groups：页面此刻画着的分组（含留在原位的已完成）；index：放下后在目标组里排第几（kit SortDrag 的 SortDrop.index）
 */
export function planTodoDrop(groups: readonly Group[], rows: readonly Row[], d: { id: string; from: string; to: string; index: number }, now: number, tz: Tz, today: DateStr): TodoSortPlan | null {
  const from = groups.find((g) => groupId(g) === d.from);
  const to = groups.find((g) => groupId(g) === d.to);
  const item = from?.items.find((x) => x.todo.id === d.id);
  const row = rows.find((r) => r.id === d.id);
  if (!from || !to || !item || !row || !canDropTodo(d.from, d.to)) return null;
  const cross = from !== to;
  const keys = planMove(to.items.map((x) => ({ id: x.todo.id, key: x.todo.sortKey })), d.id, d.index, now, item.todo.sortKey);
  const writes: TodoSortWrite[] = keys
    .filter((k) => k.id !== d.id)
    .map((k) => ({ id: k.id, patch: { sort_key: k.key }, undo: { sort_key: k.prev }, due: false }));
  const mine = keys.find((k) => k.id === d.id);
  const patch: Record<string, unknown> = mine ? { sort_key: mine.key } : {};
  const undo: Record<string, unknown> = mine ? { sort_key: mine.prev } : {};
  if (cross) {
    const due = dueOfGroup(to, today);
    if (due === null) return null;
    const t = item.todo;
    // 拖到今天、截止时刻今天已经过了：去掉截止时刻（不然一放下又落回“过期”）
    const late = t.dueTime !== null && to.key === 'today' && msAt(due, parseHm(t.dueTime), tz) <= now;
    Object.assign(patch, { due, ...(late ? { due_time: null, remind_before_min: null } : {}), updated_at: now });
    Object.assign(undo, { due: t.due, ...(late ? { due_time: t.dueTime, remind_before_min: row['remind_before_min'] ?? null } : {}) });
  }
  if (Object.keys(patch).length > 0) writes.unshift({ id: d.id, patch, undo, due: cross });
  return { writes, to: cross ? to : null };
}

/** 改了截止的那一笔带不带 remind 标记（改之后会响、或改之前还会响；同编辑页的口径） */
function remindOf(rows: readonly Row[], w: TodoSortWrite, data: Record<string, unknown>, now: number, tz: Tz): boolean {
  if (!w.due) return false;
  const row = rows.find((r) => r.id === w.id);
  if (!row) return false;
  return todoRemindFlag({ row, after: todoRemindFields({ ...row, ...data }), prevRemindAt: undefined, now, tz });
}

/** 这一批一起发出去（不在中间等，页面少重画几次）；有一笔没成回第一笔没成的结果，调用方整批撤回（写成的照原值写回） */
export async function applyTodoSort(writes: readonly TodoSortWrite[], rows: readonly Row[], undo: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  const res = await Promise.all(writes.map((w) => {
    const data = undo ? { ...w.undo, ...(w.due ? { updated_at: now } : {}) } : w.patch;
    return savePatch('todos', w.id, data, remindOf(rows, w, data, now, tz));
  }));
  return res.find((r) => r !== 'saved') ?? 'saved';
}
