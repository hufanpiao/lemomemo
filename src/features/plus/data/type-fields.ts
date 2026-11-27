// 打字条输入框下面那排签：分类、日期、提醒
// • 签就是预览：边打字边把本机规则（planLocal）认出来的分类、日期时刻、提醒填进签里，界面画成浅黄（auto）
// • 手选优先（picks）：点过的格子盖过识别结果，记下时 applyPicks 把手选值盖到这一批的每一条上（AI 回来的结果也一样，只改没点过的格子）；
//   手选了日期，一句话不再拆成多条（并成一条，标题是整句原话，同“拆错了，合并成一条”的 mergeItems）
// • 提醒默认：有时刻自动提醒（默认亮、点掉就不提醒）；话里明说“提醒我”也点亮（remindAsked）；
//   没时刻点亮：全天日程、有截止日的待办记 remind_days 0（当天），没日子的待办不提醒。写库在 capture-map.ts 的 remind
// • 待办只有截止日、没有“一段时间”（span 只对全天日程）；日程有时刻才有时长（dur）
// 纯 TS：不准 import React
import { addDays, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { allDayDuration, allDaySpanDays, EVENT_DURATION_DEFAULT } from '../../../../shared/logic/calendar/event-span.ts';
import type { CaptureItem } from '../../../../shared/logic/capture-map.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { mergeItems } from './type-flow.ts';

/** 签按哪种画：待办（截止日 + 可选时刻）或日程（日子 + 时刻和时长 / 全天跨几天） */
export type FieldKind = 'todo' | 'event';

/** 手点过的格子（有这个键 = 点过，值盖过识别结果）。time 为 null = 点了“不定 / 全天”；project 为 null = 点了“不分类” */
export interface Picks {
  project?: string | null;
  date?: DateStr;
  time?: string | null;
  /** 日程时长（分钟），有时刻时用 */
  dur?: number;
  /** 全天日程一共几天（1 = 就一天） */
  span?: number;
  remind?: boolean;
}

/** 签上现在显示的值（手选盖过识别） */
export interface Fields {
  kind: FieldKind;
  project: string | null;
  date: DateStr | null;
  time: string | null;
  dur: number;
  span: number;
  remind: boolean;
  /** 认出来的、没手点过：签画浅黄。日期签看日期和时刻两格都没点过 */
  auto: { project: boolean; date: boolean; remind: boolean };
}

/** 常用时刻、时长、跨天 */
export const TIME_CHOICES = ['09:00', '14:00', '19:00'] as const;
export const DUR_CHOICES = [30, 60, 120] as const;
export const SPAN_CHOICES = [2, 3, 7] as const;

export type DayChoice = 'today' | 'tomorrow' | 'after' | 'nextMon';

/** 今天、明天、后天、下周一（今天是周一时下周一是 7 天后） */
export function dayChoices(today: DateStr): { key: DayChoice; date: DateStr }[] {
  const toMon = (8 - weekdayOf(today)) % 7 || 7;
  return [
    { key: 'today', date: today },
    { key: 'tomorrow', date: addDays(today, 1) },
    { key: 'after', date: addDays(today, 2) },
    { key: 'nextMon', date: addDays(today, toMon) },
  ];
}

const isRec = (it: AiItem | undefined): it is AiItem & { kind: FieldKind } => it?.kind === 'todo' || it?.kind === 'event';

/**
 * 签上的值：items 是本机规则这一刻的结果（不带日历页的默认日子，这样“认出来的”只算话里说了的）；
 * fallback 是没认出类型时按哪种画（日历页日程、别的页待办）；remindWord 是话里有没有“提醒我”
 */
export function fieldsOf(items: readonly AiItem[], picks: Picks, o: { fallback: FieldKind; remindWord: boolean }): Fields {
  const first = items[0];
  const got = isRec(first) ? first : undefined;
  const kind: FieldKind = got?.kind ?? o.fallback;
  const rProject = got?.project ?? null;
  const rDate = got ? (got.kind === 'event' ? got.date : got.due) : null;
  const rTime = got?.time ?? null;
  const project = 'project' in picks ? (picks.project ?? null) : rProject;
  const date = picks.date ?? rDate;
  const time = 'time' in picks ? (picks.time ?? null) : rTime;
  const rDur = got?.duration_min ?? null;
  const dur = picks.dur ?? (rTime !== null && rDur !== null ? rDur : EVENT_DURATION_DEFAULT);
  const span = picks.span ?? (kind === 'event' && time === null && rTime === null && rDur !== null ? allDaySpanDays(rDur) : 1);
  const remind = picks.remind ?? (o.remindWord || time !== null);
  return {
    kind, project, date, time, dur, span, remind,
    auto: {
      project: !('project' in picks) && rProject !== null,
      date: picks.date === undefined && !('time' in picks) && (rDate !== null || rTime !== null),
      remind: picks.remind === undefined && o.remindWord,
    },
  };
}

/** 写库的一条：AiItem 加上提醒开关（capture-map 的 remind） */
export type PickedItem = AiItem & Pick<CaptureItem, 'remind'>;

/** 有没有手点过格子 */
export const anyPick = (p: Picks): boolean => Object.keys(p).length > 0;

/**
 * 记下时把手选值盖到这一批上（本机或 AI 的结果都过这里）：只盖点过的格子，没点过的照识别结果；只动待办和日程。
 * 手选了日期：多条并成一条（标题是整句原话），日子换成手选的、不再问过去的月日。话里说了“提醒我”、没点过提醒签：提醒打开
 */
export function applyPicks(items: readonly AiItem[], picks: Picks, raw: string, remindWord: boolean): PickedItem[] {
  const merged = picks.date !== undefined && items.length > 1 ? mergeItems(items, raw) : null;
  const list: readonly AiItem[] = merged ? [merged] : items;
  const remind = picks.remind ?? (remindWord ? true : undefined);
  return list.map((it): PickedItem => {
    if (!isRec(it)) return it;
    let n: AiItem = { ...it };
    if ('project' in picks) n.project = picks.project ?? null;
    if (picks.date !== undefined) {
      n = n.kind === 'event' ? { ...n, date: picks.date, date_basis: 'ymd', confirm: null } : { ...n, due: picks.date, date_basis: 'ymd', confirm: null };
    }
    if ('time' in picks) n.time = picks.time ?? null;
    if (n.kind === 'event') {
      // 原来全天（时长按天记）、手点了时刻：时长换成手选的，没选按默认 1 小时，不把“2 天”带成有时刻日程的时长
      if (n.time !== null && (picks.dur !== undefined || it.time === null)) n.duration_min = picks.dur ?? EVENT_DURATION_DEFAULT;
      if (n.time === null && picks.span !== undefined) n.duration_min = allDayDuration(picks.span);
    }
    return remind === undefined ? n : { ...n, remind };
  });
}
