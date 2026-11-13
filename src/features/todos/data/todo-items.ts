// 待办子任务（R-350；方案 docs/10-架构/方案-R350-待办子任务.md 第 4～6 节，负责人 11-07 定 Q1～Q10 按推荐）：分组、进度、排序键、粘贴拆行、
// 勾选时主待办跟着改的规则，以及子任务的写入（经 core 的 edit-save，不碰 outbox）
// • 简单勾选清单：每项只有标题和勾选框；不单独设时间、不单独提醒（写入一律不带 remind 标记）
// • 主待办只在两个动作时被自动改（5.5）：勾上最后一项 → 主待办完成（列表页出撤销条，撤销时两件一起撤回，Q1）；
//   主待办已完成时取消勾某一项 → 主待办改回未完成（不出撤销条，Q2）。直接勾主待办、删项、加项都不动主待办（Q3）
// • 上限（6.1）：每条待办没删的子任务 ITEMS_MAX = 20（服务器留到 30，超了回 items_quota、outbox 丢掉）；标题去掉首尾空白后 1～100 字
// • 排序键（6.4）：新加的 = 最大值 + 1；挪到两项之间 = 中点；中点和两边差得太小（< 1e-9）时整组按顺序重编 1、2、3……
// • 子任务的 insert 不用自己写 deps：core 入队时按 todo_id 自动依赖主待办（outbox-new-item.ts 的 PARENT_OF），主待办一定先发
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { cutGraphemes } from '../../../../shared/logic/short.ts';
import { TODO_ITEM_TITLE_MAX } from '../../../../shared/schema/rows.ts';
import { saveDeleted, saveInsert, savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { collection } from '../../../core/store.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { setTodoDone } from './todo-actions.ts';
import type { Row } from './todo-list.ts';

export { TODO_ITEM_TITLE_MAX };

/** 本机库表名（shared/manifests/todos.ts） */
export const ITEMS_TABLE = 'todo_items';
/** 每条待办最多几项（客户端；方案 6.1、Q6） */
export const ITEMS_MAX = 20;
/** 两个排序键差得比这还小就整组重编（6.4） */
const SORT_EPS = 1e-9;

export interface Subtask {
  id: string;
  todoId: string;
  title: string;
  done: boolean;
  sort: number;
  createdAt: number;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 集合里的一行 → 子任务；删了、撤销了、没有 todo_id 的返回 null */
export function subtaskOf(r: Row): Subtask | null {
  const todoId = r['todo_id'];
  if (typeof todoId !== 'string' || !isLiveRow(r)) return null;
  return {
    id: r.id, todoId, title: typeof r['title'] === 'string' ? r['title'] : '', done: r['done'] === true,
    sort: num(r['sort'], 0), createdAt: num(r['created_at'], 0),
  };
}

const bySort = (a: Subtask, b: Subtask): number => a.sort - b.sort || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 按主待办分组，每组按排序键排；只放还在的 */
export function groupSubtasks(rows: readonly Row[]): ReadonlyMap<string, readonly Subtask[]> {
  const m = new Map<string, Subtask[]>();
  for (const r of rows) {
    const s = subtaskOf(r);
    if (!s) continue;
    const list = m.get(s.todoId);
    if (list) list.push(s);
    else m.set(s.todoId, [s]);
  }
  for (const list of m.values()) list.sort(bySort);
  return m;
}

/** 已勾 / 总数 */
export function progressOf(items: readonly Subtask[]): { done: number; total: number } {
  return { done: items.reduce((n, i) => n + (i.done ? 1 : 0), 0), total: items.length };
}

/** 子任务标题：去掉首尾空白，截到 100 个 UTF-16 单元、不截半个字（同 trimItemTitle 的写法） */
export const cleanTitle = (s: string): string => cutGraphemes(s.trim(), TODO_ITEM_TITLE_MAX).trim();

/** 粘贴多行（5.3）：按行拆成多项，去掉空行；只取 room 项，多出来的条数在 dropped */
export function splitLines(text: string, room: number): { titles: string[]; dropped: number } {
  const lines = text.split(/\r\n|\r|\n/).map(cleanTitle).filter((s) => s !== '');
  const titles = lines.slice(0, Math.max(0, room));
  return { titles, dropped: lines.length - titles.length };
}

/** 新加一项的排序键：当前最大值 + 1（没有项时 1） */
export function nextSort(items: readonly Subtask[]): number {
  return items.reduce((m, i) => Math.max(m, i.sort), 0) + 1;
}

/**
 * 把第 from 项挪到第 to 个位置（都是下标，to 是挪完以后的位置）：返回要改的 [id, 新排序键]。
 * 一般只改挪动的那一项；中点和两边差得太小时整组按新顺序重编 1、2、3……，只返回变了的
 */
export function moveSorts(items: readonly Subtask[], from: number, to: number): { id: string; sort: number }[] {
  const moved = items[from];
  if (!moved || from === to || to < 0 || to >= items.length) return [];
  const order = items.filter((_, i) => i !== from);
  order.splice(to, 0, moved);
  const prev = order[to - 1]?.sort;
  const next = order[to + 1]?.sort;
  const sort = prev === undefined ? (next ?? 1) - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
  const tight = (prev !== undefined && sort - prev < SORT_EPS) || (next !== undefined && next - sort < SORT_EPS);
  if (!tight) return [{ id: moved.id, sort }];
  return order.flatMap((it, i) => (it.sort === i + 1 ? [] : [{ id: it.id, sort: i + 1 }]));
}

/**
 * 勾 / 取消勾一项以后主待办要不要跟着改（5.5）：true = 改成完成，false = 改回未完成，null = 不动。
 * items 是勾之前这条待办的全部子任务
 */
export function autoTodo(todoDone: boolean, items: readonly Subtask[], id: string, done: boolean): boolean | null {
  if (!items.some((i) => i.id === id)) return null;
  if (!done) return todoDone ? false : null;
  return !todoDone && items.every((i) => i.id === id || i.done) ? true : null;
}

/** 新建一项的整行（insert 要整行可写列；deleted_at、undone 只能 update，不放） */
export function newSubtaskRow(id: string, todoId: string, title: string, sort: number, now: number): Record<string, unknown> & { id: string } {
  return { id, todo_id: todoId, title, done: false, sort, created_at: now, updated_at: now };
}

/** 依次写几项，遇到第一个没写进去的就停，返回它的结果（都写进去了是 saved） */
async function each<T>(list: readonly T[], f: (x: T) => Promise<SaveOutcome>): Promise<SaveOutcome> {
  for (const x of list) {
    const out = await f(x);
    if (out !== 'saved') return out;
  }
  return 'saved';
}

/** 加几项（排在最后）；调用方已按 ITEMS_MAX 截好 */
export function addSubtasks(todoId: string, items: readonly Subtask[], titles: readonly string[], now: number, newId: () => string = () => crypto.randomUUID()): Promise<SaveOutcome> {
  const base = nextSort(items);
  return each(titles.map((title, i) => newSubtaskRow(newId(), todoId, title, base + i, now)), (row) => saveInsert(ITEMS_TABLE, row, false));
}

export function setSubtaskTitle(id: string, title: string, now: number): Promise<SaveOutcome> {
  return savePatch(ITEMS_TABLE, id, { title, updated_at: now }, false);
}

/** 删除（软删，不进“最近删除”，6.3）/ 撤销删除 */
export function setSubtaskDeleted(id: string, deleted: boolean, now: number): Promise<SaveOutcome> {
  return saveDeleted(ITEMS_TABLE, id, deleted, now);
}

export function moveSubtask(items: readonly Subtask[], from: number, to: number, now: number): Promise<SaveOutcome> {
  return each(moveSorts(items, from, to), (m) => savePatch(ITEMS_TABLE, m.id, { sort: m.sort, updated_at: now }, false));
}

/**
 * 勾 / 取消勾一项（4 第 4 条：同一次点击里先入队子任务的 patch，再入队主待办的 patch，各自发送、各自幂等）。
 * auto：主待办被顺带改成了什么（true 完成 → 列表页出撤销条；false 改回未完成；null 没动）。todo 是主待办现在的行
 */
export async function tickSubtask(
  todo: Row, items: readonly Subtask[], id: string, done: boolean, now: number, tz: Tz,
): Promise<{ out: SaveOutcome; auto: boolean | null }> {
  const out = await savePatch(ITEMS_TABLE, id, { done, updated_at: now }, false);
  if (out !== 'saved') return { out, auto: null };
  // 写完再按集合里最新的值判断（连点几项时，前一项的保存可能在调用方渲染之后才回到集合；调用方给的 items、todo 只作后备）
  const fresh = groupSubtasks(collection<Row>(ITEMS_TABLE).getSnapshot()).get(todo.id) ?? items;
  const row = collection<Row>('todos').getSnapshot().find((r) => r.id === todo.id) ?? todo;
  const auto = autoTodo(row['done'] === true, fresh.map((i) => (i.id === id ? { ...i, done } : i)), id, done);
  if (auto === null) return { out, auto: null };
  const todoOut = await setTodoDone(row, auto, now, tz);
  if (todoOut !== 'saved') return { out: todoOut, auto: null };
  rlog(`todo sub auto ${auto ? 'done' : 'undone'}`);   // 运行日志只记事件，不记标题（列表页、编辑页共用这一处）
  return { out: todoOut, auto };
}

/** 撤销“自动完成”（Q1）：刚勾的那一项取消勾，主待办回到未完成。todo 是主待办现在的行（已完成） */
export async function undoAutoDone(todo: Row, id: string, now: number, tz: Tz): Promise<SaveOutcome> {
  const out = await savePatch(ITEMS_TABLE, id, { done: false, updated_at: now }, false);
  return out === 'saved' ? setTodoDone(todo, false, now, tz) : out;
}
