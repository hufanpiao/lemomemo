// 提醒按钮（架构 5.9“按类型区分的提醒按钮”、0.29 续第 47、57、122 条；R-181；需求澄清 2.6；TC-B2-21）
// actionsFor(item, kind, now, tz) 返回这一条提醒要显示的按钮和按了以后写的时刻；界面（横幅、按钮条、整页提醒）只按它渲染。
// 按钮固定（R-181，0.29 续第 122 条；原来“今晚 10 点”“5 分钟后”两个替换按钮作废）：
//   • 日程：知道了 / 10 分钟后 / 开始时再提醒；开始时刻减现在 < 60 秒（含已开始）时不显示“开始时再提醒”，只剩两个
//   • 待办：知道了 / 10 分钟后 / 1 小时后 / 明天再提醒（current_tz 的明天 09:00）；“1 小时后”落进免打扰的推迟到免打扰结束
//   • 纪念日：知道了 / 明天再提醒 / 生成待办（明天再提醒用纪念日的提醒时刻，默认 09:00；生成待办由调用方新建待办）
// 写什么：点“稍后”类按钮写 snooze_at = at；点“知道了”写 notified_for = 这一条的 remind_at（at 为 null）
// “开始时刻”（startAtOf，0.29 续第 47、57 条）：有具体时刻、带 tz 的日程按自己的 tz；有时刻、没 tz 的（浮动）按 current_tz；
//   全天日程算当天的 remind.default_time（current_tz，出厂 09:00）
// 纯函数：不读设置、不碰 DOM、不看进程时区，“现在”由调用方传（A15）
import { addDays, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { applyDnd, type Dnd } from './remind.ts';

export type RemindActionKey = 'ack' | 'snooze10' | 'atStart' | 'hour1' | 'tomorrow' | 'genTodo';

export interface RemindAction {
  readonly key: RemindActionKey;
  /** 按了以后写进 snooze_at 的时刻（epoch ms）；“知道了”“生成待办”为 null */
  readonly at: number | null;
}

export type RemindActionKind = 'event' | 'todo' | 'anniv';

/** 日程算开始时刻要的字段 */
export interface EventStartRow {
  readonly date: DateStr;
  readonly time: string | null;
  readonly tz: Tz | null;
}

/** remind.default_time 没设时的出厂值 */
export const DEFAULT_REMIND_TIME = '09:00';
/** “明天再提醒”的时刻（待办，需求澄清 2.6：第二天早上 9:00） */
export const TOMORROW_TIME = '09:00';
/** 离开始不到这么久就不显示“开始时再提醒” */
export const AT_START_MIN_LEAD_MS = 60_000;

const MIN_MS = 60_000;

/** 日程的开始时刻（epoch ms）；defaultTime 是设置 remind.default_time（全天日程用） */
export function startAtOf(row: EventStartRow, tz: Tz, defaultTime: string = DEFAULT_REMIND_TIME): number {
  if (row.time === null) return msAt(row.date, parseHm(defaultTime), tz);
  return msAt(row.date, parseHm(row.time), row.tz ?? tz);
}

export interface ActionsOpts {
  /** 免打扰（current_tz）；“1 小时后”落进去就推迟到结束 */
  readonly dnd?: Dnd;
  /** 设置 remind.default_time（全天日程的“开始”） */
  readonly defaultTime?: string;
  /** 纪念日的提醒时刻（anniv.default_time 或这一条的 remind_time），“明天再提醒”用；默认 09:00 */
  readonly annivTime?: string;
}

/** 明天的某个墙上时刻（current_tz） */
function tomorrowAt(now: number, tz: Tz, hm: string): number {
  return msAt(addDays(todayOf(now, tz), 1), parseHm(hm), tz);
}

export function actionsFor(item: EventStartRow, kind: 'event', now: number, tz: Tz, opts?: ActionsOpts): RemindAction[];
export function actionsFor(item: unknown, kind: 'todo' | 'anniv', now: number, tz: Tz, opts?: ActionsOpts): RemindAction[];
/** 这一条提醒的按钮（顺序就是显示顺序，第一个是主按钮“知道了”） */
export function actionsFor(item: unknown, kind: RemindActionKind, now: number, tz: Tz, opts: ActionsOpts = {}): RemindAction[] {
  const ack: RemindAction = { key: 'ack', at: null };
  if (kind === 'anniv') {
    return [ack, { key: 'tomorrow', at: tomorrowAt(now, tz, opts.annivTime ?? DEFAULT_REMIND_TIME) }, { key: 'genTodo', at: null }];
  }
  const snooze10: RemindAction = { key: 'snooze10', at: now + 10 * MIN_MS };
  if (kind === 'todo') {
    return [
      ack,
      snooze10,
      { key: 'hour1', at: applyDnd(now + 60 * MIN_MS, tz, opts.dnd ?? null) },
      { key: 'tomorrow', at: tomorrowAt(now, tz, TOMORROW_TIME) },
    ];
  }
  const start = startAtOf(item as EventStartRow, tz, opts.defaultTime);
  const out = [ack, snooze10];
  if (start - now >= AT_START_MIN_LEAD_MS) out.push({ key: 'atStart', at: start });
  return out;
}
