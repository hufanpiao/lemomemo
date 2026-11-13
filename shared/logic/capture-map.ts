// “＋”识别结果 → 要写进库的一行（B3 任务单 S10、M10、接口先定第 5 条；架构第 7 节“待办有截止时刻”、0.29 续第 124、133 条；R-169、R-183、R-104）。
// 客户端保存处（features/plus，经 outbox）和 claude-intake 写库处都 import 这一份，两边写出来的行一样：
//   • 待办：AI / 本机规则输出里一律叫 time，存成 todos 行时才映射成 due_time，remind_before_min 默认 60；
//     有 time 没有 due（只说了时刻）记今天（ai.ts 已补，这里再兜一次，数据库要求有 due_time 必须有 due）；
//   • 日程：没有日子（AI 给了 null）记今天；有时刻时 tz 记“记录时的时区”（ctx.tz：客户端是本机时区，claude-intake 是 profiles.current_tz），
//     提醒默认提前 15 分钟（和完整新建页 event-edit.ts 的 DEFAULT_REMIND_MIN 一致）；全天日程不设提醒（按设置的全天提醒走）；
//   • 简称：AI 给了 short 存 short、short_by = 'ai'；没给存 null，显示时取 itemShort（shared/logic/short.ts 的 displayShort）；
//     本机规则（origin = 'rule'）不写 short；
//   • 纪念日：阴历一律存中国农历 lunar_variant = 'cn'（R-169，说“음력”也一样），用户到编辑页能改成韩国阴历；B3 只测这一映射，端到端随 B5；
//   • 随手记：写入路径 B4 才有，这里返回 null（调用方当作“这条存不了”）；
//   • 不写 ai_status（系统列，客户端无权写；B3 保持 none，任务单 M5）；不写 deleted_at、undone（只能 update，新增时由库的默认值给 null、false）；不写 repeat（R-163：重复只记最近一次）。
// 输出的 events、todos 行原样能过 shared/schema/rows.ts 的 insertSchema（tests/shared/capture-map-insert.test.ts 核对）。纯函数，不读时钟（now 由调用方传）。
import type { DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { ITEM_NOTE_MAX, ITEM_TITLE_MAX, PROJECT_MAX, RAW_TEXT_MAX } from '../schema/rows.ts';
import { DEFAULT_REMIND_BEFORE_MIN } from './remind.ts';
import { cutGraphemes } from './short.ts';
import { todoRowOf, type NewTodoRow } from './todo-row.ts';

/** 有时刻的日程默认提前几分钟提醒（同 event-edit.ts 的 DEFAULT_REMIND_MIN） */
export const EVENT_REMIND_MIN_DEFAULT = 15;
/** 日程默认时长（同 event-edit.ts 的 DEFAULT_DURATION_MIN） */
export const EVENT_DURATION_DEFAULT = 60;
/** 纪念日名字最长（anniversaries.name 的约束） */
export const ANNIV_NAME_MAX = 60;

/** capture-map 用到的识别结果字段（shared/schema/ai.ts 的 AiItem、本机规则的输出都满足） */
export interface CaptureItem {
  kind: 'event' | 'todo' | 'note' | 'anniv';
  title: string;
  date: DateStr | null;
  time: string | null;
  duration_min: number | null;
  due: DateStr | null;
  important: boolean;
  project: string | null;
  body: string | null;
  short: string | null;
  anniv: {
    type: 'birthday' | 'anniversary' | 'countdown';
    calendar: 'solar' | 'lunar';
    month: number;
    day: number;
    is_leap: boolean;
    year: number | null;
  } | null;
}

export interface CaptureCtx {
  /** 这一条的 uuid（每条一个） */
  id: string;
  /** 同一句话拆出来的几条共用一个 batch_id（撤销按它整批撤） */
  batchId: string;
  /** 毫秒，created_at、updated_at 用 */
  now: number;
  /** 今天（todayOf(now, tz)），日程没日子、待办只说了时刻时用 */
  today: DateStr;
  /** 记录时的时区：有时刻的日程写进 events.tz */
  tz: Tz;
  /** page：打字；voice：录音；chat：经连接码（claude-intake） */
  source: 'page' | 'voice' | 'chat';
  /** 原话（语音是转写），截到 RAW_TEXT_MAX 存进 raw_text */
  rawText: string;
  /** ai：AI 识别的（short 记 short_by = 'ai'）；rule：本机规则的（不写 short） */
  origin: 'ai' | 'rule';
}

export type CaptureRow =
  | { table: 'events'; row: EventRow }
  | { table: 'todos'; row: TodoRow }
  | { table: 'anniversaries'; row: AnnivRow };

export interface EventRow {
  id: string; title: string; date: DateStr; time: string | null; tz: string | null; duration_min: number;
  project: string; note: string; source: CaptureCtx['source']; raw_text: string; location: string;
  short: string | null; short_by: 'ai' | null; push_show_title: null; batch_id: string;
  remind_min: 15 | null; remind_days: null; notified_for: null; snooze_at: null;
  created_at: number; updated_at: number;
}

/** 待办行：整行只在 todo-row.ts 一份 */
export type TodoRow = NewTodoRow;

export interface AnnivRow {
  id: string; kind: 'birthday' | 'anniversary' | 'countdown'; name: string; calendar: 'solar' | 'lunar'; lunar_variant: 'cn';
  month: number; day: number; is_leap: boolean; year: number | null; note: string; created_at: number; updated_at: number;
}

// 各文字列的截断只在这里做：按 UTF-16 单元（同 insertSchema 的 max）、不截半个字（cutGraphemes）

function shortOf(item: CaptureItem, ctx: CaptureCtx): { short: string | null; short_by: 'ai' | null } {
  if (ctx.origin !== 'ai' || !item.short) return { short: null, short_by: null };
  return { short: item.short, short_by: 'ai' };
}

/** 纪念日的映射（R-169：阴历一律 cn；阳历没有闰月） */
export function annivRow(item: CaptureItem, ctx: CaptureCtx): AnnivRow | null {
  const a = item.anniv;
  if (!a) return null;
  return {
    id: ctx.id,
    kind: a.type,
    name: cutGraphemes(item.title, ANNIV_NAME_MAX),
    calendar: a.calendar,
    lunar_variant: 'cn',
    month: a.month,
    day: a.day,
    is_leap: a.calendar === 'lunar' ? a.is_leap : false,
    year: a.year,
    note: cutGraphemes(item.body ?? '', ITEM_NOTE_MAX),
    created_at: ctx.now,
    updated_at: ctx.now,
  };
}

/** 一条识别结果 → 一行；随手记（B4）和缺 anniv 的纪念日返回 null */
export function captureRow(item: CaptureItem, ctx: CaptureCtx): CaptureRow | null {
  const raw = cutGraphemes(ctx.rawText, RAW_TEXT_MAX);
  const project = cutGraphemes(item.project ?? '', PROJECT_MAX);
  const note = cutGraphemes(item.body ?? '', ITEM_NOTE_MAX);
  const title = cutGraphemes(item.title, ITEM_TITLE_MAX);
  switch (item.kind) {
    case 'event': {
      const time = item.time;
      return {
        table: 'events',
        row: {
          id: ctx.id, title, date: item.date ?? ctx.today, time, tz: time === null ? null : ctx.tz,
          duration_min: item.duration_min ?? EVENT_DURATION_DEFAULT, project, note, source: ctx.source, raw_text: raw, location: '',
          ...shortOf(item, ctx), push_show_title: null, batch_id: ctx.batchId,
          remind_min: time === null ? null : EVENT_REMIND_MIN_DEFAULT, remind_days: null,
          notified_for: null, snooze_at: null, created_at: ctx.now, updated_at: ctx.now,
        },
      };
    }
    case 'todo': {
      const dueTime = item.time;
      const due = item.due ?? (dueTime !== null ? ctx.today : null);
      return {
        table: 'todos',
        row: todoRowOf({
          id: ctx.id, title, due, important: item.important, project, note, source: ctx.source, raw_text: raw, batch_id: ctx.batchId,
          ...shortOf(item, ctx), remind_days: null, due_time: dueTime, remind_before_min: dueTime === null ? null : DEFAULT_REMIND_BEFORE_MIN, now: ctx.now,
        }),
      };
    }
    case 'anniv': {
      const row = annivRow(item, ctx);
      return row ? { table: 'anniversaries', row } : null;
    }
    case 'note':
      return null;
    default: {
      const never: never = item.kind;
      return never;
    }
  }
}
