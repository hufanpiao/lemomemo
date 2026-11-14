// 取消、改期、完成：在本机缓存里找候选、用户点了才写、撤销写回原值（架构 5.14 第 7 点；B4b-3）
// • 候选：shared/logic/parse/match-target.ts（target 已过 resolveTarget；不调 AI、不联网、不含隐私记）
// • 取消 = 软删（deleted_at，进“最近删除”，不标完成）；撤销写回 deleted_at = null
// • 完成：done = true、done_at = now（和列表里打勾同一写法）；撤销写回 done = false 和原来的 done_at（原来没有的写 0，同 today-actions）
// • 改期：日程改 date、time，tz 写成设备当前时区（4.6，和手动编辑一样；候选的 date、time 已经换算到设备时区），
//   换了时间以后旧的“知道了”“稍后”不算数：同一次写入清 notified_for、snooze_at（同 calendar/data/event-edit.ts 的 patchOf）；
//   待办改 due、due_time：说了新时刻的写 due_time（原来没有时刻的提前量按 remindBeforeOnSetDueTime 给默认），没说新时刻的保留原来的，
//   只说时刻的只改 due_time（原来没有 due 的记今天）。撤销把改之前这几列写回
// • 批量（all）：同一个 batch 一起写、一起撤；写不进去的那条不算（结果里 failed 计数）
// • remind 标记：这几种写入都可能改提醒（删了要撤、改期要重算），一律带 true 让它尽快上服务器（只是早发，不改结果）
// 纯 TS：不准 import React（A1）
import { addDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { matchTarget, type TargetEvent, type TargetHit, type TargetMatch, type TargetTodo } from '../../../../shared/logic/parse/match-target.ts';
import type { PlusTarget, TargetIntent } from '../../../../shared/logic/parse/resolve-target.ts';
import { remindBeforeOnSetDueTime } from '../../../../shared/logic/remind.ts';
import type { PlusTo } from '../../../../shared/schema/intent.ts';
import { savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { collection } from '../../../core/store.ts';

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };
export type { TargetHit, TargetMatch };

const tableOf = (h: TargetHit): 'events' | 'todos' => (h.kind === 'event' ? 'events' : 'todos');
const strOr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 候选（本机缓存的日程、待办行，形状不对的行由 match-target 自己跳过） */
export function candidates(target: PlusTarget, events: readonly Row[], todos: readonly Row[], now: number, tz: Tz): TargetMatch {
  return matchTarget(target, { events: events as unknown as readonly TargetEvent[], todos: todos as unknown as readonly TargetTodo[] }, now, tz);
}

/** 改期到哪天几点（卡片按钮“改到 11/10 周二”和写入共用）：没说日子的用原来的，没说时刻的保留原时刻 */
export function moveTo(h: TargetHit, to: PlusTo, today: DateStr): { date: DateStr; time: string | null } {
  return { date: to.date ?? h.date ?? today, time: to.time ?? h.time };
}

/** 一条要写什么（不写库）；返回 [改之后, 改之前] 两份同样的列 */
export function patchFor(intent: TargetIntent, h: TargetHit, row: Row, to: PlusTo | null, now: number, tz: Tz): [Record<string, unknown>, Record<string, unknown>] {
  if (intent === 'cancel') return [{ deleted_at: now, updated_at: now }, { deleted_at: row['deleted_at'] ?? null, updated_at: now }];
  if (intent === 'complete') {
    const prevAt = typeof row['done_at'] === 'number' ? row['done_at'] : 0;
    return [{ done: true, done_at: now, updated_at: now }, { done: row['done'] === true, done_at: prevAt, updated_at: now }];
  }
  const m = moveTo(h, to ?? { date: null, time: null }, todayOf(now, tz));
  if (h.kind === 'event') {
    const after = { date: m.date, time: m.time, tz: m.time === null ? strOr(row['tz']) : tz, notified_for: null, snooze_at: null, updated_at: now };
    const before = { date: row['date'], time: row['time'] ?? null, tz: row['tz'] ?? null, notified_for: row['notified_for'] ?? null, snooze_at: row['snooze_at'] ?? null, updated_at: now };
    return [after, before];
  }
  const prevTime = strOr(row['due_time']);
  const prevBefore = typeof row['remind_before_min'] === 'number' ? row['remind_before_min'] : null;
  const after: Record<string, unknown> = { due: m.date, due_time: m.time, updated_at: now };
  if (m.time !== null && prevTime === null) after['remind_before_min'] = remindBeforeOnSetDueTime(prevTime, prevBefore);
  const before: Record<string, unknown> = { due: row['due'] ?? null, due_time: prevTime, updated_at: now };
  if ('remind_before_min' in after) before['remind_before_min'] = prevBefore;
  return [after, before];
}

/** 写好的一批：撤销用的原值 */
export interface Applied {
  undo: { table: string; id: string; data: Record<string, unknown> }[];
  ok: number;
  failed: number;
}

export type Save = (table: string, id: string, data: Record<string, unknown>, remind: boolean) => Promise<SaveOutcome>;

/** 用户点了确认：逐条写（rows 按 id 找原行；找不到的算没写成） */
export async function applyTarget(intent: TargetIntent, hits: readonly TargetHit[], rows: ReadonlyMap<string, Row>, to: PlusTo | null, now: number, tz: Tz, save: Save = savePatch): Promise<Applied> {
  const out: Applied = { undo: [], ok: 0, failed: 0 };
  for (const h of hits) {
    const row = rows.get(h.id);
    if (!row) {
      out.failed += 1;
      continue;
    }
    const [after, before] = patchFor(intent, h, row, to, now, tz);
    if ((await save(tableOf(h), h.id, after, true)) === 'saved') {
      out.ok += 1;
      out.undo.push({ table: tableOf(h), id: h.id, data: before });
    } else out.failed += 1;
  }
  return out;
}

/** 撤销：把改之前的值写回；返回写回成功几条 */
export async function undoTarget(a: Applied, now: number, save: Save = savePatch): Promise<number> {
  let n = 0;
  for (const u of a.undo) if ((await save(u.table, u.id, { ...u.data, updated_at: now }, true)) === 'saved') n += 1;
  return n;
}

/** 查找结果每行“⋯”菜单里的几项（线框 sGest：日程 编辑 / 删除；待办 完成 / 推迟到明天 / 改时间 / 删除；纪念日、随手记 删除）。
 *  编辑、改时间、转成… 进各自的编辑页，不在这里；写法和撤销同上面的取消、完成、改期 */
export type RowAct = 'done' | 'tomorrow' | 'delete';
const TABLE: Record<'event' | 'todo' | 'anniv' | 'note', string> = { event: 'events', todo: 'todos', anniv: 'anniversaries', note: 'notes' };

export async function rowAct(act: RowAct, kind: 'event' | 'todo' | 'anniv' | 'note', id: string, at: { date: DateStr | null; time: string | null }, now: number, tz: Tz, save: Save = savePatch, get: (table: string, id: string) => Row | undefined = (t, i) => collection<Row>(t).get(i)): Promise<Applied> {
  const row = get(TABLE[kind], id);
  if (!row) return { undo: [], ok: 0, failed: 1 };
  const h: TargetHit = { kind: kind === 'event' ? 'event' : 'todo', id: row.id, date: at.date, time: kind === 'todo' ? strOr(row['due_time']) : at.time };
  const [after, before] =
    act === 'delete' ? patchFor('cancel', h, row, null, now, tz)
    : act === 'done' ? patchFor('complete', h, row, null, now, tz)
    : patchFor('reschedule', h, row, { date: addDays(todayOf(now, tz), 1), time: null }, now, tz);
  const ok = (await save(TABLE[kind], row.id, after, kind !== 'note')) === 'saved';
  return ok ? { undo: [{ table: TABLE[kind], id: row.id, data: before }], ok: 1, failed: 0 } : { undo: [], ok: 0, failed: 1 };
}
