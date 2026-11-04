// 提醒的写入（架构 5.3“处理以后，另一边的提醒怎么消失”、5.9“按类型区分的提醒按钮”；B2 任务单 FA-4）：经 core 的 edit-save（write.*），不碰 outbox
// • “知道了”写 notified_for = 这一条的 remind_at（普通字段，不报冲突，4.4 第 3 步）；只有“稍后”、没有提醒时刻的那种（remind_at 为 null）把 snooze_at 清掉
// • “稍后”类按钮写 snooze_at = actionsFor 给的时刻
// • 都带 remind 标记（整条提前发，4.2）：处理结果越早上服务器，别的设备的通知越早收回（R-52、R-317）
// • 纪念日的“生成待办”归 B5（纪念日提醒本批不出）
import { savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import type { Reminder } from './reminder-model.ts';

export type { SaveOutcome } from '../../../core/edit-save.ts';

const tableOf = (r: Pick<Reminder, 'kind'>): 'events' | 'todos' => (r.kind === 'event' ? 'events' : 'todos');

/** “知道了”的 patch */
export function ackPatch(r: Pick<Reminder, 'remindAt'>, now: number): Record<string, unknown> {
  return r.remindAt === null ? { snooze_at: null, updated_at: now } : { notified_for: r.remindAt, updated_at: now };
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
