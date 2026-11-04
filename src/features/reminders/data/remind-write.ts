// 提醒的写入（架构 5.3“处理以后，另一边的提醒怎么消失”、5.9“按类型区分的提醒按钮”；B2 任务单 FA-4）：经 core 的 edit-save（write.*），不碰 outbox
// • “知道了”写 notified_for = 这一条的 remind_at（普通字段，不报冲突，4.4 第 3 步）；只有“稍后”、没有提醒时刻的那种（remind_at 为 null）把 snooze_at 清掉
// • “稍后”类按钮写 snooze_at = actionsFor 给的时刻
// • 都带 remind 标记（整条提前发，4.2）：处理结果越早上服务器，别的设备的通知越早收回（R-52、R-317）
// • 纪念日的“生成待办”归 B5（纪念日提醒本批不出）
// • R4-L1：日程这一行在 outbox 里还有没上服务器的“换一次提醒”的改动（date、remind_days，或 time 在空和非空之间切换）时，
//   “知道了”不写 notified_for——outbox 会把两次写合并成 {date, notified_for: 旧时刻}，把新的那一次提醒压住；
//   这时只在本机关掉横幅和通知、记进本次会话的已处理集合（hooks/useReminders.ts），判断用 timingPending；
//   那条改动发出去以后，提醒时刻没变的再补写一次（第三轮 L10，hooks/useReminders.ts 的 laterAcks）
import { savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import type { Reminder } from './reminder-model.ts';

export type { SaveOutcome } from '../../../core/edit-save.ts';

const tableOf = (r: Pick<Reminder, 'kind'>): 'events' | 'todos' => (r.kind === 'event' ? 'events' : 'todos');

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
 * 一项 patch 里有没有“换一次提醒”的改动：date、remind_days，或者 time 在空和非空之间切换。
 * • 有时刻 → 全天：time 写成 null，看得出来。
 * • 全天 → 有时刻（第三轮 L11）：patch 只带新的 time，看不出原来是不是空；服务器那份行在 core 缓存（CachedRow.server）里，
 *   功能这一层只拿得到叠好的 view，所以这里认的是 calendar 的 event-edit.ts patchOf 的写法——time 在空和非空之间切换时，
 *   同一次写入里带 notified_for: null（和服务器触发器同一口径，审查 M1）。只改时刻（09:00 → 10:00）不带。
 *   patchOf 改了这个写法，这里要跟着改；两边各有一条测试钉住同一个 patch 形状
 *   （calendar/__tests__/event-edit.test.ts“改了时刻：tz 一起带上”、本功能 remind-all-day.test.ts“L11”）
 */
export function hasTimingChange(data: Readonly<Record<string, unknown>>): boolean {
  return 'date' in data || 'remind_days' in data || ('time' in data && (data['time'] === null || data['notified_for'] === null));
}

/**
 * 这时候按“知道了”，notified_for 会不会被合并进“换一次提醒”的那个 patch（R4-L1）：
 * 只有这一行在 outbox 里的**最后一项**是待发、没发出去过的 patch（core/outbox.ts 只往这种项里合并），而且它带“换一次提醒”的改动，才算。
 * 已经发出去的（另开新 op_id，排在后面发）、永久失败的、新建还没同步的 insert（patch 不并进 insert）、
 * 后面又跟了一个普通 patch 的（并进那一个，排在后面发）都不算，照常写（第三轮 L9）。待办不在这条里
 */
export function timingPending(r: Pick<Reminder, 'kind' | 'id'>, items: readonly OutboxLikeItem[]): boolean {
  if (r.kind !== 'event') return false;
  const rec = `${tableOf(r)}:${r.id}`;
  const mine = items.filter((it) => it.rec === rec);
  const last = mine[mine.length - 1];
  return last !== undefined && last.op === 'patch' && last.state === 'pending' && last.sent !== true && hasTimingChange(last.data);
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

/** “全部知道了”：逐条写，返回写成功的那几条的 tag（调用方只把这些移出队列；代码审查低 2） */
export async function ackAll(list: readonly Reminder[], now: number): Promise<string[]> {
  const ok: string[] = [];
  for (const r of list) if ((await ackReminder(r, now)) === 'saved') ok.push(r.tag);
  return ok;
}
