// 提醒的写入（架构 5.3“处理以后，另一边的提醒怎么消失”、5.9“按类型区分的提醒按钮”；B2 任务单 FA-4）：经 core 的 edit-save（write.*），不碰 outbox
// • “知道了”写 notified_for = 这一条的 remind_at（普通字段，不报冲突，4.4 第 3 步）；只有“稍后”、没有提醒时刻的那种（remind_at 为 null）把 snooze_at 清掉
// • “稍后”类按钮写 snooze_at = actionsFor 给的时刻
// • 都带 remind 标记（整条提前发，4.2）：处理结果越早上服务器，别的设备的通知越早收回（R-52、R-317）
// • 纪念日（B5 S15）：“知道了”“明天再提醒”同样写 anniversaries 的 notified_for / snooze_at；“生成待办”见 genTodoFromAnniv
// • R4-L1（7h 起日程、待办、纪念日都算）：这一行在 outbox 里还有没上服务器的“换一次提醒”的改动（shared/logic/remind-occurrence.ts）时，
//   “知道了”不写 notified_for——outbox 会把两次写合并成 {date, notified_for: 旧时刻}，把新的那一次提醒压住；
//   这时只在本机关掉横幅和通知、记进本次会话的已处理集合（hooks/useReminders.ts），判断用 timingPending；
//   那条改动发出去以后，提醒时刻没变的再补写一次（第三轮 L10，hooks/useReminders.ts 的 laterAcks）
import { addDays, type DateStr } from '../../../../shared/core/date.ts';
import { occurrenceChanged } from '../../../../shared/logic/remind-occurrence.ts';
import { todoRowOf, type NewTodoRow } from '../../../../shared/logic/todo-row.ts';
import { saveInsert, savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import type { Reminder } from './reminder-model.ts';

const TABLE_OF = { event: 'events', todo: 'todos', anniv: 'anniversaries' } as const;
const tableOf = (r: Pick<Reminder, 'kind'>): (typeof TABLE_OF)[Reminder['kind']] => TABLE_OF[r.kind];

/** “知道了”的 patch */
export function ackPatch(r: Pick<Reminder, 'remindAt'>, now: number): Record<string, unknown> {
  return r.remindAt === null ? { snooze_at: null, updated_at: now } : { notified_for: r.remindAt, updated_at: now };
}

/** outbox 里的一项（core/outbox-types.ts 的 OutboxItem 里用到的几个字段；list() 按 seq 排好序） */
export interface OutboxLikeItem {
  /** `${table}:${id}` */
  readonly rec: string;
  readonly op: 'insert' | 'patch';
  readonly state: 'pending' | 'inflight' | 'failed';
  /** 发出去过（之后不再合并新修改，core/outbox.ts） */
  readonly sent?: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * 这时候按“知道了”，notified_for 会不会被合并进“换一次提醒”的那个 patch（R4-L1）：
 * 只有这一行在 outbox 里的**最后一项**是待发、没发出去过的 patch（core/outbox.ts 只往这种项里合并），而且它带“换一次提醒”的改动，才算。
 * 已经发出去的（另开新 op_id，排在后面发）、永久失败的、新建还没同步的 insert（patch 不并进 insert）、
 * 后面又跟了一个普通 patch 的（并进那一个，排在后面发）都不算，照常写（第三轮 L9）。
 * 日程、待办、纪念日一视同仁（7h）：mergePatch 对哪张表都按同一个认法丢掉这次“知道了”，这里就得对哪张表都改成只在本机了结、发完再补写，
 * 原来只管日程，纪念日离线改日期后按的“知道了”会被合进改日期那次 patch（或者被合并丢掉、本机横幅又冒出来）
 */
export function timingPending(r: Pick<Reminder, 'kind' | 'id'>, items: readonly OutboxLikeItem[]): boolean {
  const rec = `${tableOf(r)}:${r.id}`;
  const mine = items.filter((it) => it.rec === rec);
  const last = mine[mine.length - 1];
  return last !== undefined && last.op === 'patch' && last.state === 'pending' && last.sent !== true && occurrenceChanged(last.data);
}

/** “稍后”的 patch */
export function snoozePatch(at: number, now: number): Record<string, unknown> {
  return { snooze_at: at, updated_at: now };
}

export function ackReminder(r: Reminder, now: number): Promise<SaveOutcome> {
  return savePatch(tableOf(r), r.id, ackPatch(r, now), true);
}

export function snoozeReminder(r: Reminder, at: number, now: number): Promise<SaveOutcome> {
  return savePatch(tableOf(r), r.id, snoozePatch(at, now), true);
}

/**
 * 纪念日提醒的“生成待办”（B5 S15；线框“提醒响起时”第三张：新建一条待办，截止在纪念日前一天）：
 * 新建待办的整行（shared/logic/todo-row.ts 的 todoRowOf，和新建待办同一份；当天提醒、时刻用默认），
 * from_anniv_id 记来源。due 由调用方按纪念日这一次的日期算好传进来（前一天）
 */
export function annivTodoRow(id: string, title: string, due: DateStr, annivId: string, now: number): NewTodoRow {
  return todoRowOf({ id, title, due, remind_days: 0, from_anniv_id: annivId, now });
}

/** 生成待办的截止日：纪念日前一天；当天或已过按的取今天，不生成一条一出来就逾期的待办（整块评审第 14 条） */
export function annivTodoDue(annivDate: DateStr, today: DateStr): DateStr {
  const eve = addDays(annivDate, -1);
  return eve < today ? today : eve;
}

/** 生成待办：先建待办，建成了再把这条纪念日提醒按“知道了”处理；返回新待办的结果 */
export async function genTodoFromAnniv(r: Reminder, row: Record<string, unknown> & { id: string }, now: number): Promise<SaveOutcome> {
  const res = await saveInsert('todos', row, true);
  if (res === 'saved') await ackReminder(r, now).catch(() => undefined);
  return res;
}

/** “全部知道了”：逐条写，返回写成功的那几条的 tag（调用方只把这些移出队列；代码审查低 2） */
export async function ackAll(list: readonly Reminder[], now: number): Promise<string[]> {
  const ok: string[] = [];
  for (const r of list) if ((await ackReminder(r, now)) === 'saved') ok.push(r.tag);
  return ok;
}
