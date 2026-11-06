// 今天页的纯逻辑（B2 FA-2；架构 4.6 时区规则、5.9；皮肤视觉稿“现在”卡：方案 K 小时间尺，R-131、R-133）
// 不碰本机库、不读时钟：行、now、current_tz 都由调用方给，单测直接喂
// • 日程换算：固定时刻（有 time）按日程自己的 tz 换成时刻，再换成当前时区的日期和墙上时间，按换算后的日期放进“今天”；
//   和记录时的时区不同时带上原时区的墙上时间（界面写“14:00（首尔 15:00）”）；全天日程（浮动）日期原样，不换算
// • “现在”卡四种状态：live（有正在进行的）、idle（没有进行中、今天还有下一件）、done（今天的日程都结束了）、empty（今天没有日程）；
//   全天事项不算“正在进行”、不进时间轴（仍在今天列表里）
// • 时间窗 kWin：照视觉稿 kWin() 逐条移植（分钟，相对今天 0 点；跨到明天的事项可以 > 1440）
// • 没赶上：没完成、截止日早于今天的待办（逾 N 天）；今天有截止时刻、已经过了的也算（逾 0 天，界面写“已过 17:00”）
import { addDays, diffDays, minOfDay, msAt, parseHm, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/calendar/cal-items.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
// 同一时刻按标题排：按当前语言、数字按数值（和待办页共用，shared/i18n/title-compare.ts）
import { titleCompare } from '../../../../shared/i18n/title-compare.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

const MIN = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const hmOf = (min: number): string => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * 还在用的行：没删、没被撤销——判断只留一份，用 shared/logic/calendar 的 isLiveRow（前端 B 日历审查建议 1）。
 * 本机缓存的行列都是 unknown，对不上它的入参类型，这里断言一次；运行时它只看 deleted_at ?? null 和 undone !== true，
 * 任何值都一样（同一组输入的对照测试在本功能的 __tests__/live-row.test.ts）
 */
export const isLive = (r: Row): boolean => isLiveRow(r as Parameters<typeof isLiveRow>[0]);

export interface EventOcc {
  kind: 'event';
  id: string;
  title: string;
  project: string;
  /** 当前时区的日期 */
  date: DateStr;
  allDay: boolean;
  /** 时刻（epoch ms）；全天为 null */
  start: number | null;
  end: number | null;
  /** 当前时区的墙上时间 'HH:MM'；全天为 null */
  time: string | null;
  /** 和当前时区不同：日程自己的时区和那里的墙上时间（“首尔 15:00”）；相同或全天为 null */
  origin: { tz: Tz; time: string } | null;
}

/** 一条日程换算到当前时区；字段坏了返回 null（不显示，不抛） */
export function eventOcc(r: Row, current: Tz): EventOcc | null {
  const date = str(r['date']);
  if (!DATE.test(date)) return null;
  const base = { kind: 'event' as const, id: r.id, title: str(r['title']), project: str(r['project']) };
  const time = r['time'];
  if (typeof time !== 'string' || !HM.test(time)) {
    return { ...base, date, allDay: true, start: null, end: null, time: null, origin: null };
  }
  const tz = typeof r['tz'] === 'string' && r['tz'] !== '' ? r['tz'] : current;
  let start: number;
  try {
    start = msAt(date, parseHm(time), tz);
  } catch {
    return null;
  }
  const dur = typeof r['duration_min'] === 'number' && r['duration_min'] >= 1 && r['duration_min'] <= 1440 ? r['duration_min'] : 60;
  const localTime = hmOf(minOfDay(start, current));
  const origin = tz !== current && localTime !== time ? { tz, time } : null;
  return { ...base, date: todayOf(start, current), allDay: false, start, end: start + dur * MIN, time: localTime, origin };
}

/** 某一天的日程：全天的在前，有时刻的按开始先后 */
export function eventsOn(rows: readonly Row[], day: DateStr, current: Tz, locale: Locale = 'zh-CN'): EventOcc[] {
  const byTitle = titleCompare(locale);
  const out: EventOcc[] = [];
  for (const r of rows) {
    if (!isLive(r)) continue;
    const o = eventOcc(r, current);
    if (o && o.date === day) out.push(o);
  }
  return out.sort((a, b) => (a.start ?? -Infinity) - (b.start ?? -Infinity) || byTitle(a.title, b.title));
}

// ---------- “现在”卡 ----------

export interface Span {
  s: number;
  e: number;
}

/** 时间窗（分钟）：照视觉稿 kWin()。cur = 正在进行的（可多件），next = 之后的第一件 */
export function kWin(cur: readonly Span[], next: Span | null, now: number): { A: number; B: number } {
  const f30 = (x: number) => Math.floor(x / 30) * 30;
  const c30 = (x: number) => Math.ceil(x / 30) * 30;
  let A: number;
  let B: number;
  if (cur.length) {
    const s0 = Math.min(...cur.map((c) => c.s));
    const e0 = Math.max(...cur.map((c) => c.e));
    // ① 最早开始的前半小时 → 下一件结束；下一件和当前结束相隔超过 2 小时，就只到当前结束后半小时
    A = s0 - 30;
    B = next && next.s - e0 <= 120 ? next.e : e0 + 30;
  } else {
    // ② 没有进行中：此刻前半小时 → 下一件结束；下一件 3 小时以后才开始，就只到此刻后 2 小时
    A = now - 30;
    B = next && next.s - now <= 180 ? next.e : now + 120;
  }
  // ③ 两端取整到半点
  A = f30(A);
  B = c30(B);
  // ④ 最多 4 小时：从“此刻前 1 小时”向前取整开始截 4 小时；截出的结束超过原来的结束就整体往前挪
  if (B - A > 240) {
    let a = Math.max(A, f30(now - 60));
    let b = a + 240;
    if (b > B) {
      b = B;
      a = B - 240;
    }
    A = a;
    B = b;
  }
  return { A, B };
}

export type NowCard =
  | {
      state: 'live';
      /** 正在进行的，按结束先后（标题、“还剩”用第一件） */
      cur: EventOcc[];
      next: EventOcc | null;
      /** 第一件还剩几分钟（向上取整） */
      leftMin: number;
      win: { A: number; B: number };
      /** 下一件在时间窗外：时间轴下面另写一行 */
      nextOutside: boolean;
    }
  | { state: 'idle'; next: EventOcc; inMin: number; win: { A: number; B: number }; nextOutside: boolean }
  | { state: 'done' }
  | { state: 'empty' };

/** 今天的日程 → “现在”卡；today 是当前时区的今天 */
export function nowCard(todayEvents: readonly EventOcc[], now: number, current: Tz, today: DateStr = todayOf(now, current)): NowCard {
  const timed = todayEvents.filter((o) => !o.allDay && o.start !== null && o.end !== null);
  if (timed.length === 0) return { state: todayEvents.length ? 'done' : 'empty' };
  const zero = msAt(today, 0, current);
  const m = (ms: number) => (ms - zero) / MIN;
  const span = (o: EventOcc): Span => ({ s: m(o.start ?? 0), e: m(o.end ?? 0) });
  const cur = timed.filter((o) => (o.start ?? 0) <= now && now < (o.end ?? 0)).sort((a, b) => (a.end ?? 0) - (b.end ?? 0));
  const next = timed.filter((o) => (o.start ?? 0) > now).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] ?? null;
  const nowM = m(now);
  if (cur.length) {
    const win = kWin(cur.map(span), next ? span(next) : null, nowM);
    return {
      state: 'live', cur, next, leftMin: Math.ceil(((cur[0]?.end ?? now) - now) / MIN), win,
      nextOutside: next !== null && span(next).s >= win.B,
    };
  }
  if (!next) return { state: 'done' };
  const win = kWin([], span(next), nowM);
  return { state: 'idle', next, inMin: Math.ceil(((next.start ?? now) - now) / MIN), win, nextOutside: span(next).s >= win.B };
}

// ---------- 待办：今天、没赶上 ----------

export interface TodoOcc {
  kind: 'todo';
  id: string;
  title: string;
  project: string;
  done: boolean;
  important: boolean;
  due: DateStr | null;
  dueTime: string | null;
}

export function todoOcc(r: Row): TodoOcc {
  const due = str(r['due']);
  const dt = r['due_time'];
  return {
    kind: 'todo', id: r.id, title: str(r['title']), project: str(r['project']), done: r['done'] === true, important: r['important'] === true,
    due: DATE.test(due) ? due : null, dueTime: typeof dt === 'string' && HM.test(dt) ? dt : null,
  };
}

/** 截止时刻（epoch ms，按 current_tz，待办截止是浮动的）；没有截止时刻为 null */
export function dueAtOf(t: TodoOcc, current: Tz): number | null {
  return t.due && t.dueTime ? msAt(t.due, parseHm(t.dueTime), current) : null;
}

export interface Late {
  todo: TodoOcc;
  /** 逾几天；0 = 今天截止、截止时刻已过 */
  days: number;
}

/** 没赶上：没完成，截止日早于今天，或今天的截止时刻已过；逾得久的在前 */
export function lateTodos(rows: readonly Row[], now: number, current: Tz, locale: Locale = 'zh-CN'): Late[] {
  const byTitle = titleCompare(locale);
  const today = todayOf(now, current);
  const out: Late[] = [];
  for (const r of rows) {
    if (!isLive(r)) continue;
    const t = todoOcc(r);
    if (t.done || !t.due) continue;
    const days = diffDays(t.due, today);
    if (days > 0) out.push({ todo: t, days });
    else if (days === 0 && (dueAtOf(t, current) ?? Infinity) <= now) out.push({ todo: t, days: 0 });
  }
  return out.sort((a, b) => b.days - a.days || (a.todo.dueTime ?? '').localeCompare(b.todo.dueTime ?? '') || byTitle(a.todo.title, b.todo.title));
}

/** 今天截止、还没过的待办（过了的进“没赶上”）；有截止时刻的按时刻在前，没完成的在前 */
export function todayTodos(rows: readonly Row[], now: number, current: Tz, locale: Locale = 'zh-CN'): TodoOcc[] {
  const byTitle = titleCompare(locale);
  const today = todayOf(now, current);
  const out: TodoOcc[] = [];
  for (const r of rows) {
    if (!isLive(r)) continue;
    const t = todoOcc(r);
    if (t.due !== today) continue;
    if (!t.done && (dueAtOf(t, current) ?? Infinity) <= now) continue;
    out.push(t);
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || byTitle(a.title, b.title));
}

/** 明天（当前时区） */
export function tomorrowOf(now: number, current: Tz): DateStr {
  return addDays(todayOf(now, current), 1);
}

/** 时长文字的拆分（界面按语言拼）：照视觉稿 kDur，h 为 0 时只写分 */
export function splitDur(min: number): { h: number; m: number } {
  const v = Math.max(0, Math.round(min));
  return { h: Math.floor(v / 60), m: v % 60 };
}
