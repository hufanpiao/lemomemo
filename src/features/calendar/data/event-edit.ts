// 日程编辑页的数据逻辑（B2 任务单 FA-2；架构 4.6 时区规则、5.9 地点 / 链接；TC-B2-01、02）
// • 有具体时刻的是固定时刻：events.tz 记“记录时设备的时区”，提醒按 msAt(date, time − remind_min, tz)，换了地方也不变；
//   和当前时区不同时，编辑页写出“在你这里是几点”（列表的“14:00（首尔 15:00）”在 FA-2 第二段）
// • 全天日程是浮动时刻：不存 tz（time、tz 都为 null），提醒按 remind_days
// • 时区只让选 Intl.supportedValuesOf('timeZone') 里的值（架构 0.49 第 10 条 / D7；原来存的值不在表里也照样列出、不强改）
// • 改了什么就只写什么（patchOf）；改了标题且简称是 AI 起的，同一个 patch 清掉 short、short_by（5.12 L3）
// • 带不带提醒：shared/logic/remind.ts 的 remindAtOf（全天日程那一支 shared 还没写，返回 null，等后续一段补）
// 纯 TS：不准 import React（A1）
import { addDays, DAY_MINUTES, diffDays, fmtHm, minOfDay, msAt, parseHm, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { isValidTz, type Tz } from '../../../../shared/core/tz.ts';
import {
  allDayDuration,
  allDaySpanDays,
  EVENT_DURATION_DEFAULT,
  eventDurationMin,
  ownTzOf,
  placeEvent,
  type EventPlacement,
} from '../../../../shared/logic/calendar/event-span.ts';
import { trimItemTitle } from '../../../../shared/schema/rows.ts';
import { ALL_DAY_LIVE_UNTIL, EVENT_REMIND_MIN_DEFAULT, remindAtOf } from '../../../../shared/logic/remind.ts';
import { remindLive, rowRemindPending } from '../../../core/remind-flag.ts';

export interface EventForm {
  title: string;
  date: DateStr;
  /** null = 全天 */
  time: string | null;
  duration_min: number;
  /** 有时刻时必填；全天为 null */
  tz: Tz | null;
  /** 有时刻时：提前几分钟提醒；null = 不提醒 */
  remind_min: 0 | 15 | 30 | 60 | 1440 | null;
  /** 全天时：0 当天 / 1 前一天 / null 不提醒 */
  remind_days: 0 | 1 | null;
  location: string;
  project: string;
  note: string;
}

/** 有时刻的日程“提醒”的选项（和 events.remind_min 的约束一致） */
export const REMIND_MIN_OPTIONS: readonly EventForm['remind_min'][] = [null, 0, 15, 30, 60, 1440];
export { ITEM_TITLE_MAX, PROJECT_MAX, ITEM_NOTE_MAX as NOTE_MAX } from '../../../../shared/schema/rows.ts';
export const LOCATION_MAX = 200;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const remindMin = (v: unknown): EventForm['remind_min'] =>
  v === 0 || v === 15 || v === 30 || v === 60 || v === 1440 ? v : null;
const remindDays = (v: unknown): 0 | 1 | null => (v === 0 || v === 1 ? v : null);
const duration = (v: unknown): number => eventDurationMin(typeof v === 'number' ? v : Number.NaN);

/** 集合里的一行 → 表单 */
export function formOf(row: Readonly<Record<string, unknown>>): EventForm {
  const time = strOrNull(row['time']);
  return {
    title: str(row['title']),
    date: str(row['date']),
    time,
    duration_min: duration(row['duration_min']),
    tz: time === null ? null : strOrNull(row['tz']),
    remind_min: remindMin(row['remind_min']),
    remind_days: remindDays(row['remind_days']),
    location: str(row['location']),
    project: str(row['project']),
    note: str(row['note']),
  };
}

/** 新建：给定日期、默认 9:00 开始 1 小时、按本机时区、提前 15 分钟 */
export function emptyForm(date: DateStr, tz: Tz): EventForm {
  return {
    title: '', date, time: '09:00', duration_min: EVENT_DURATION_DEFAULT, tz, remind_min: EVENT_REMIND_MIN_DEFAULT, remind_days: null,
    location: '', project: '', note: '',
  };
}

/** 全天 / 有时刻切换后把连带字段改好：有时刻必须有 tz（没有就用本机的）；全天不存 tz */
export function normalize(next: EventForm, device: Tz): EventForm {
  if (next.time === null) return { ...next, tz: null };
  return next.tz === null ? { ...next, tz: device } : next;
}

// ---------- 结束日期、时刻（R-444 跨天日程；数据做法见 shared/logic/calendar/event-span.ts 文件头） ----------

/** 有时刻的日程按它自己的时区放（event-span.ts 的 placeEvent、ownTzOf）；全天、日期时刻坏了、时区算不出来为 null */
function ownPlace(form: EventForm, device: Tz): { p: Extract<EventPlacement, { allDay: false }>; tz: Tz } | null {
  if (form.time === null) return null;
  try {
    const tz = ownTzOf(form.tz, device);
    const p = placeEvent(form, tz);
    return p && !p.allDay ? { p, tz } : null;
  } catch {
    return null;
  }
}

/** 有时刻的日程：结束在哪天几点（按日程自己的时区）；全天、没日期、算不出来为 null */
export function endAtOf(form: EventForm, device: Tz): { date: DateStr; time: string } | null {
  const o = ownPlace(form, device);
  return o ? { date: todayOf(o.p.endMs, o.tz), time: fmtHm(minOfDay(o.p.endMs, o.tz)) } : null;
}

/**
 * 有时刻的日程选了结束日期、时刻 → 时长（分钟）。
 * 结束日期早于开始日期的按开始那天（界面另写一行提示）；结束日期是开始那天、时刻又不晚于开始的，照旧当作跨到第二天（只改时刻时和原来一样）。
 * 都按墙上时间换成时刻再相减（第二天也用 msAt 算），夏令时那天不差 1 小时。
 * 超过上限（31 天）的不悄悄截短，原样返回，由写入的校验拒掉、编辑页状态行提示（useEditRecord 的 rejected）；算不出来的返回原来的时长
 */
export function durationTo(form: EventForm, endDate: DateStr, endTime: string, device: Tz): number {
  if (form.time === null) return form.duration_min;
  try {
    const tz = ownTzOf(form.tz, device);
    const start = msAt(form.date, parseHm(form.time), tz);
    const day = endDate < form.date ? form.date : endDate;
    const endMin = parseHm(endTime);
    let end = msAt(day, endMin, tz);
    if (end <= start && day === form.date) end = msAt(addDays(day, 1), endMin, tz);
    return Math.max(1, Math.round((end - start) / 60_000));
  } catch {
    return form.duration_min;
  }
}

/** 全天日程的最后一天（含） */
export function allDayLastOf(form: EventForm): DateStr {
  return form.date === '' ? '' : addDays(form.date, allDaySpanDays(form.duration_min) - 1);
}

/** 全天日程选了最后一天 → 时长（event-span.ts 的 allDayDuration：只选一天写默认 1 小时，多天写“天数 × 1440”；早于开始日期的按一天） */
export function allDayDurationTo(date: DateStr, lastDate: DateStr): number {
  return allDayDuration(diffDays(date, lastDate) + 1);
}

/**
 * 有时刻 → 全天：按它占了几天记（allDayDuration）。不超过一天的（含 22:00 开始 1440 分钟、23:00 开始 90 分钟）都算一天；
 * 超过一天的按 placeEvent 算出的最后一天数天数
 */
export function allDayDurationOf(form: EventForm, device: Tz): number {
  if (form.time === null) return form.duration_min;
  const o = eventDurationMin(form.duration_min) <= DAY_MINUTES ? null : ownPlace(form, device);
  return allDayDuration(o ? diffDays(o.p.date, o.p.lastDate) + 1 : 1);
}

/**
 * 全天 → 有时刻（没记着切走前的时长时；form 已经是切过去的有时刻表单）：跨几天的结束在最后一天同一时刻再过 1 小时，
 * 按墙上时间算（durationTo，夏令时那几天不差 1 小时）；只占一天的（含旧的 1440）一律回默认 1 小时
 */
export function timedDurationOf(form: EventForm, allDayDur: number, device: Tz): number {
  const days = allDaySpanDays(allDayDur);
  if (days <= 1 || form.time === null) return EVENT_DURATION_DEFAULT;
  return durationTo(form, addDays(form.date, days - 1), form.time, device) + EVENT_DURATION_DEFAULT;
}

/** 可选的时区：Intl 支持的全部，加上原来存的值（不在表里也列出），去重排序 */
export function tzChoices(keep: readonly (Tz | null)[] = [], list: () => readonly string[] = supportedTz): readonly Tz[] {
  const all = new Set(list());
  for (const t of keep) if (t) all.add(t);
  return [...all].sort();
}

function supportedTz(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/**
 * 这个时区能不能写（Intl 认得、表里有，或者是 keep 里的值：原来存的、本机的）。
 * 本机时区要放进 keep：Intl.supportedValuesOf 不列 'UTC'（也可能只列旧名），本机就是 UTC 时切回有时刻会被拒（CI TZ=UTC 暴露）
 */
export function tzAllowed(tz: Tz, keep: Tz | null | readonly (Tz | null)[], list: () => readonly string[] = supportedTz): boolean {
  if (typeof keep === 'string' ? tz === keep : keep !== null && keep.includes(tz)) return true;
  if (!isValidTz(tz)) return false;
  // Intl.supportedValuesOf 不可用（Safari 15.4 以前）时表是空的：退回只看 isValidTz（代码审查 S5），不然切回有时刻时本机时区也过不了
  const all = list();
  return all.length === 0 || all.includes(tz);
}

/** 固定时刻在当前时区是几点、哪一天（和记录时的时区不同时编辑页写出来）；时区一样或全天返回 null */
export function localOf(form: EventForm, current: Tz): { date: DateStr; time: string } | null {
  if (form.time === null || form.tz === null || form.tz === current || form.date === '') return null;
  const ms = msAt(form.date, parseHm(form.time), form.tz);
  const time = fmtHm(minOfDay(ms, current));
  const date = todayOf(ms, current);
  return date === form.date && time === form.time ? null : { date, time };
}


const FIELDS: readonly (keyof EventForm)[] = [
  'title', 'date', 'time', 'duration_min', 'tz', 'remind_min', 'remind_days', 'location', 'project', 'note',
];

/** 前后两份表单 → patch（只放变了的列）；没变返回 null */
export function patchOf(row: Readonly<Record<string, unknown>>, prev: EventForm, next: EventForm, now: number): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const k of FIELDS) if (next[k] !== prev[k]) data[k] = next[k];
  if (Object.keys(data).length === 0) return null;
  // 有时刻必须有时区（库的 check）：time 改了就把 tz 一起带上，免得只带一半
  if ('time' in data && !('tz' in data)) data['tz'] = next.tz;
  // 换了一次提醒：旧的“知道了”“稍后”不再算数，同一次写入里清掉（B2 前端增量审查 M1；R-336 只认同一次提醒）。
  // 口径和服务器触发器一致：date、remind_days 改了，或者 time 在空和非空之间切换（全天 ↔ 有时刻）；
  // pushed_for 是系统列，本机不写，由服务器触发器清。
  // shared/logic/remind-occurrence.ts 的 occurrenceChanged（outbox 合并、提醒的 timingPending 共用）依赖这个写法：time 在空和非空之间切换时同时带 notified_for: null，
  // 它靠这一点在 outbox 里认出“全天 → 有时刻”（R4-L1 第三轮 L11）；改这里的写法要一起改那边
  if ('date' in data || 'remind_days' in data || (prev.time === null) !== (next.time === null)) {
    data['notified_for'] = null;
    data['snooze_at'] = null;
  }
  if ('title' in data && row['short_by'] === 'ai') {
    data['short'] = null;
    data['short_by'] = null;
  }
  data['updated_at'] = now;
  return data;
}

/** 新建的整行 */
export function newEventRow(id: string, form: EventForm, now: number): Record<string, unknown> & { id: string } {
  return {
    id, ...form, title: trimItemTitle(form.title), source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null,
    batch_id: null, notified_for: null, snooze_at: null, created_at: now, updated_at: now,
  };
}

/** 日程按同一个写法：新建、改了这几列不传 prevRemindAt（eventRemindAt 不看这个参数，传不传结果一样；代码审查补审“日程”一节） */
export const EVENT_TIMING_COLS: readonly string[] = ['date', 'time', 'tz', 'remind_min', 'remind_days'];

type RowLike = Readonly<Record<string, unknown>> | undefined;
const isDel = (v: unknown): boolean => v !== null && v !== undefined;

export function prevRemindAtOf(row: RowLike, data: Readonly<Record<string, unknown>> | null): number | null | undefined {
  if (data === null || row === undefined) return undefined;
  if (EVENT_TIMING_COLS.some((c) => c in data)) return undefined;
  return typeof row['remind_at'] === 'number' ? row['remind_at'] : null;
}

// 全天日程按 remind_days 和 current_tz 算（shared 的全天分支）。这里拿不到设置 remind.default_time（调用方 kit/hooks/useEditRecord 也拿不到），
// 判断“还会不会响”时当天提醒按 23:59 算：当天结束前都算会响，用户把默认时刻设得再晚也不漏标（架构 5.3 第 4 步（11-04））
export { ALL_DAY_LIVE_UNTIL };
const remindRow = (f: EventForm, deleted: boolean) => ({ date: f.date, time: f.time, tz: f.tz, remind_min: f.remind_min, remind_days: f.remind_days, deleted_at: deleted ? 1 : null });

/**
 * 写入的 remind 标记：改之后的提醒时刻不早于 now − 2 分钟，或者改之前还会响（代码审查 S2、S14、S16，规则同 core/remind-flag.ts）；
 * 删除 / 恢复也走这里（data 里带 deleted_at）
 */
export function hasRemind(c: { row: RowLike; data: Readonly<Record<string, unknown>> | null; prev: EventForm | null; next: EventForm; tz: Tz; now: number }): boolean {
  if (c.next.date === '') return false;
  const delAfter = c.data && 'deleted_at' in c.data ? isDel(c.data['deleted_at']) : isDel(c.row?.['deleted_at']);
  if (remindLive(remindAtOf('event', remindRow(c.next, delAfter), c.tz, c.now, prevRemindAtOf(c.row, c.data), ALL_DAY_LIVE_UNTIL), c.now)) return true;
  if (c.prev === null || c.row === undefined || isDel(c.row['deleted_at'])) return false;
  if (rowRemindPending(c.row, c.now)) return true;   // S14：按过“稍后”
  if (c.prev.date === '') return false;
  // 改之前那一份按“其余重算”传它自己的 remind_at；已经过了的提醒不用撤（不算，免得改一下过去的日程也整条提前发）
  const before = remindAtOf('event', remindRow(c.prev, false), c.tz, c.now, prevRemindAtOf(c.row, {}), ALL_DAY_LIVE_UNTIL);
  return remindLive(before, c.now);
}
