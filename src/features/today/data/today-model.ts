// 今天页的纯逻辑（B2 FA-2；架构 4.6 时区规则、5.9；皮肤视觉稿“现在”卡：方案 K 小时间尺，R-131、R-133）
// 不碰本机库、不读时钟：行、now、current_tz 都由调用方给，单测直接喂
// • 日程换算：固定时刻（有 time）按日程自己的 tz 换成时刻，再换成当前时区的日期和墙上时间，按换算后的日期放进“今天”；
//   和记录时的时区不同时带上原时区的墙上时间（界面写“14:00（首尔 15:00）”）；全天日程（浮动）日期原样，不换算
// • “现在”卡六种状态（NowState）：live、idle、far（下一件在时间尺外）、done、allday（只有全天的）、empty；nowCard 把时刻文字、
//   时间尺位置、剩几分钟都算好，界面只查表拼字。全天事项不算“正在进行”、不进时间轴（仍在今天列表里）；昨天开始、还没结束的算进来（nowEvents）
// • 时间窗 kWin：照视觉稿 kWin() 逐条移植（分钟，相对今天 0 点；跨到明天的事项可以 > 1440）
// • 没赶上：没完成、截止日早于今天的待办（逾 N 天）；今天有截止时刻、已经过了的也算（逾 0 天，界面写“已过 17:00”）。
//   “逾期”规则和读待办行只在 shared/logic/todo-row.ts（isLate、todoOf，和待办页共用）
import { addDays, diffDays, fmtHm, minOfDay, msAt, parseHm, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { isLate, todoOf, type TodoFields } from '../../../../shared/logic/todo-row.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
// 同一时刻按标题排：按当前语言、数字按数值（和待办页共用，shared/i18n/title-compare.ts）
import { titleCompare } from '../../../../shared/i18n/title-compare.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

const MIN = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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
  const localTime = fmtHm(minOfDay(start, current));
  const origin = tz !== current && localTime !== time ? { tz, time } : null;
  return { ...base, date: todayOf(start, current), allDay: false, start, end: start + dur * MIN, time: localTime, origin };
}

/** 某一天的日程：全天的在前，有时刻的按开始先后 */
export function eventsOn(rows: readonly Row[], day: DateStr, current: Tz, locale: Locale = 'zh-CN'): EventOcc[] {
  const byTitle = titleCompare(locale);
  const out: EventOcc[] = [];
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
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

/** “现在”卡的状态：live 有正在进行的；idle 下一件在时间尺里；far 下一件在时间尺外（窗口里一件都没有）；
 *  done 今天有带时刻的日程、都结束了；allday 今天只有全天日程；empty 今天没有日程 */
export type NowState = 'live' | 'idle' | 'far' | 'done' | 'allday' | 'empty';

/** 时间尺上的一块：cur 正在进行的第一件、co 同时进行的第二件（第二条轨道，视觉稿 kRuler 最多两条）、nxt 下一件；
 *  x0、x1 是 0～1 的位置，clipL、clipR 被窗口截断的一端，done 已过去的比例（nxt 为 0） */
export interface NowSeg {
  kind: 'cur' | 'co' | 'nxt';
  id: string;
  label: string;
  lane: 0 | 1;
  x0: number;
  x1: number;
  clipL: boolean;
  clipR: boolean;
  done: number;
}

/** 整点刻度：x 是 0～1 的位置，text 照视觉稿写“9:00”（小时不补零），edge 是贴左边、右边的那一个 */
export interface NowTick {
  x: number;
  text: string;
  edge: 'l' | 'r' | null;
}

/** “现在”卡要画的全部数：界面只拼文案、查表，不再自己算时间（R-423 整块评审第 7、10、11 条） */
export interface NowCard {
  state: NowState;
  /** 此刻的墙上时间 HH:MM（按时区换算，不靠“离 0 点几分钟”，夏令时那天也对；秒数直接舍去） */
  nowText: string;
  /** 正在进行几件（live；页头“进行中 N 件”） */
  liveN: number;
  /** 标题行：live 第一件的标题、idle“开始时刻 标题”；其余为 null，界面写暖心句 */
  title: string | null;
  /** 页头右边的分钟数：live 第一件还剩几分、idle 几分后开始；其余为 null（far 的“几分后”只在卡底写一次） */
  left: number | null;
  /** live 第二件：一件写“同时：标题 · 到 HH:MM · 还剩”，三件及以上写“同时还有 N 件” */
  also: { title: string; end: string; left: number } | { more: number } | null;
  /** 时间尺下面一行：下一件在窗口外写一次“下一件 …”；done 时写明天的第一件 */
  foot: { kind: 'next'; time: string; title: string; inMin: number } | { kind: 'tomorrow'; time: string; title: string } | null;
  /** allday：第一件全天日程的标题和件数（页头“全天 · 休假”） */
  allDay: { title: string; n: number } | null;
  /** 时间尺：轨道数、此刻竖线的位置、色块、刻度 */
  ruler: { lanes: 1 | 2; mark: number; segs: NowSeg[]; ticks: NowTick[] };
}

/** 喂给“现在”卡的日程：今天的，加上昨天开始、此刻还没结束的（跨零点的日程 00:30 时仍是“进行中”，整块评审第 4 条） */
export function nowEvents(rows: readonly Row[], now: number, current: Tz, locale: Locale = 'zh-CN'): EventOcc[] {
  const today = todayOf(now, current);
  const carry = eventsOn(rows, addDays(today, -1), current, locale).filter((o) => !o.allDay && (o.end ?? 0) > now);
  return [...carry, ...eventsOn(rows, today, current, locale)];
}

/** 日程 → “现在”卡；today 是当前时区的今天；tomorrowFirst 是明天第一件带时刻的日程（done 时写在卡底） */
export function nowCard(events: readonly EventOcc[], now: number, current: Tz, today: DateStr = todayOf(now, current), tomorrowFirst: EventOcc | null = null): NowCard {
  const zero = msAt(today, 0, current);
  const off = (ms: number) => (ms - zero) / MIN;
  const span = (o: EventOcc): Span => ({ s: off(o.start ?? 0), e: off(o.end ?? 0) });
  const untilMin = (ms: number | null) => Math.ceil(((ms ?? now) - now) / MIN);
  const hmOf = (ms: number | null) => fmtHm(minOfDay(ms ?? now, current));

  const timed = events.filter((o) => !o.allDay && o.start !== null && o.end !== null);
  const allDays = events.filter((o) => o.allDay);
  const cur = timed.filter((o) => (o.start ?? 0) <= now && now < (o.end ?? 0)).sort((a, b) => (a.end ?? 0) - (b.end ?? 0));
  const next = timed.filter((o) => (o.start ?? 0) > now).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] ?? null;
  const nowM = off(now);
  const win = kWin(cur.map(span), next ? span(next) : null, nowM);
  const nextFar = next !== null && span(next).s >= win.B;
  const [c0, c1] = cur;
  const state: NowState = c0 ? 'live' : next ? (nextFar ? 'far' : 'idle') : timed.length ? 'done' : allDays.length ? 'allday' : 'empty';

  const X = (min: number) => (Math.min(Math.max(min, win.A), win.B) - win.A) / (win.B - win.A);
  const seg = (o: EventOcc | null | undefined, kind: NowSeg['kind'], lane: 0 | 1): NowSeg | null => {
    if (!o) return null;
    const { s, e } = span(o);
    if (e <= win.A || s >= win.B) return null;
    const p = Math.max(s, win.A);
    const q = Math.min(e, win.B);
    const done = kind === 'nxt' ? 0 : Math.max(0, Math.min(1, (nowM - p) / (q - p)));
    return { kind, id: o.id, label: o.project || o.title, lane, x0: X(s), x1: X(e), clipL: s < win.A, clipR: e > win.B, done };
  };
  const ticks: NowTick[] = [];
  for (let t = Math.ceil(win.A / 60) * 60; t <= win.B; t += 60) {
    ticks.push({ x: X(t), text: `${Math.floor(minOfDay(zero + t * MIN, current) / 60)}:00`, edge: t === win.A ? 'l' : t === win.B ? 'r' : null });
  }

  return {
    state,
    nowText: hmOf(now),
    liveN: cur.length,
    title: c0 ? c0.title : state === 'idle' && next ? `${next.time ?? ''} ${next.title}` : null,
    left: c0 ? untilMin(c0.end) : state === 'idle' && next ? untilMin(next.start) : null,
    also: cur.length > 2 ? { more: cur.length - 1 } : c1 ? { title: c1.title, end: hmOf(c1.end), left: untilMin(c1.end) } : null,
    foot:
      next && nextFar
        ? { kind: 'next', time: next.time ?? '', title: next.title, inMin: untilMin(next.start) }
        : state === 'done' && tomorrowFirst?.time
          ? { kind: 'tomorrow', time: tomorrowFirst.time, title: tomorrowFirst.title }
          : null,
    allDay: state === 'allday' && allDays[0] ? { title: allDays[0].title, n: allDays.length } : null,
    ruler: {
      lanes: c1 ? 2 : 1,
      mark: X(nowM),
      segs: [seg(c0, 'cur', 0), seg(c1, 'co', 1), seg(next, 'nxt', 0)].filter((x): x is NowSeg => x !== null),
      ticks,
    },
  };
}

// ---------- 待办：今天、没赶上 ----------

/** 读一行和“逾期”规则在 shared/logic/todo-row.ts（和待办页共用） */
export interface TodoOcc extends TodoFields {
  kind: 'todo';
}

export const todoOcc = (r: Row): TodoOcc => ({ kind: 'todo', ...todoOf(r) });

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
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (t.due && isLate(t, now, current)) out.push({ todo: t, days: diffDays(t.due, today) });
  }
  return out.sort((a, b) => b.days - a.days || (a.todo.dueTime ?? '').localeCompare(b.todo.dueTime ?? '') || byTitle(a.todo.title, b.todo.title));
}

/** 今天截止、还没过的待办（过了的进“没赶上”）；有截止时刻的按时刻在前，没完成的在前 */
export function todayTodos(rows: readonly Row[], now: number, current: Tz, locale: Locale = 'zh-CN'): TodoOcc[] {
  const byTitle = titleCompare(locale);
  const today = todayOf(now, current);
  const out: TodoOcc[] = [];
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (t.due === today && !isLate(t, now, current)) out.push(t);
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || byTitle(a.title, b.title));
}

// ---------- 已过去 ----------

/** 今天的安排里“已过去”的（定稿线框 s1“已过去的折叠成一行”，时间河 river()“▸ 已过去 2 件：10:30 SignPlex 字幕校对 · 买咖啡豆 ✓”）：
 *  有时刻、结束不晚于此刻的日程，和做完的待办；全天日程不算（没有结束时刻）。其余的照原顺序留在列表里 */
export function splitPast<E extends Pick<EventOcc, 'end'>, T extends Pick<TodoOcc, 'done'>>(
  events: readonly E[],
  todos: readonly T[],
  now: number,
): { pastEvents: E[]; pastTodos: T[]; events: E[]; todos: T[] } {
  const ended = (o: E): boolean => o.end !== null && o.end <= now;
  return {
    pastEvents: events.filter(ended),
    pastTodos: todos.filter((t) => t.done),
    events: events.filter((o) => !ended(o)),
    todos: todos.filter((t) => !t.done),
  };
}

/** 明天（当前时区） */
export function tomorrowOf(now: number, current: Tz): DateStr {
  return addDays(todayOf(now, current), 1);
}

/** 暖心句选第几句（负责人 11-14）：按用户时区的当天日期固定，同一天每次打开同一句，第二天换下一句（从 1970-01-01 起的天数取余） */
export function cheerIndex(today: DateStr, n: number): number {
  return n > 0 ? ((diffDays('1970-01-01', today) % n) + n) % n : 0;
}

/** 时长文字的拆分（界面按语言拼）：照视觉稿 kDur，h 为 0 时只写分 */
export function splitDur(min: number): { h: number; m: number } {
  const v = Math.max(0, Math.round(min));
  return { h: Math.floor(v / 60), m: v % 60 };
}
