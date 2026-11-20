// 今天页的纯逻辑（B2 FA-2；架构 4.6 时区规则、5.9；皮肤视觉稿“现在”卡：方案 K 小时间尺，R-131、R-133）
// 不碰本机库、不读时钟：行、now、current_tz 都由调用方给，单测直接喂
// • 日程换算：固定时刻（有 time）按日程自己的 tz 换成时刻，再换成当前时区的日期和墙上时间，按换算后的日期放进“今天”；
//   和记录时的时区不同时带上原时区的墙上时间（界面写“14:00（首尔 15:00）”）；全天日程（浮动）日期原样，不换算
// • “现在”卡六种状态（NowState）：live、idle、far（下一件在时间尺外）、done、allday（只有全天的）、empty；nowCard 把时刻文字、
//   时间尺位置、剩几分钟都算好，界面只查表拼字。全天事项不算“正在进行”、不进时间轴（仍在今天列表里）；昨天开始、还没结束的算进来（nowEvents）
// • 时间窗 kWin：照视觉稿 kWin() 逐条移植（分钟，相对今天 0 点；跨到明天的事项可以 > 1440）
// • 没赶上：没完成、截止日早于今天的待办（逾 N 天）；今天有截止时刻、已经过了的也算（逾 0 天，界面写“已过 17:00”）。
//   “逾期”规则和读待办行只在 shared/logic/todo-row.ts（isLate、todoOf，和待办页共用）
import { addDays, DAY_MINUTES, diffDays, fmtHm, minOfDay, msAt, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { str } from '../../../../shared/core/field.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { coversDay, ownTzOf, placeEvent, spanRowOf, spanTextOn, type EventPlacement, type SpanText } from '../../../../shared/logic/calendar/event-span.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { projectColorIndex, type ProjectColor } from '../../../../shared/logic/project-color.ts';
import { compareTodos, isLate, lingerView, todoOf, type TodoFields } from '../../../../shared/logic/todo-row.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
// 同一时刻按标题排：按当前语言、数字按数值（和待办页共用，shared/i18n/title-compare.ts）
import { titleCompare } from '../../../../shared/i18n/title-compare.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

/** 没有留在原位的（keep 的默认值） */
const NONE: ReadonlySet<string> = new Set();

const MIN = 60_000;


export interface EventOcc {
  kind: 'event';
  id: string;
  title: string;
  project: string;
  /** 当前时区的日期（开始那天） */
  date: DateStr;
  /** 最后一天（R-444 跨天日程；只占一天时等于 date） */
  lastDate: DateStr;
  allDay: boolean;
  /** 时刻（epoch ms）；全天为 null */
  start: number | null;
  end: number | null;
  /** 当前时区的墙上时间 'HH:MM'；全天为 null */
  time: string | null;
  /** 和当前时区不同：日程自己的时区和那里的墙上时间（“首尔 15:00”）；相同或全天为 null */
  origin: { tz: Tz; time: string } | null;
  /** 放在哪几天、几点（event-span.ts 的 placeEvent；行在某一天怎么写直接交给 spanTextOn） */
  place: EventPlacement;
}

/** 一条日程换算到当前时区；字段坏了返回 null（不显示，不抛）。放在哪几天、回落规则同日历（event-span.ts 的 placeEvent） */
export function eventOcc(r: Row, current: Tz): EventOcc | null {
  const row = spanRowOf(r);
  const p = row && placeEvent(row, current);
  if (!row || !p) return null;
  const base = { kind: 'event' as const, id: r.id, title: str(r['title']), project: str(r['project']), date: p.date, lastDate: p.lastDate, place: p };
  if (p.allDay) return { ...base, allDay: true, start: null, end: null, time: null, origin: null };
  const time = fmtHm(p.startMin);
  // 和记录时的时区不同：带上那里的墙上时间（ownTzOf：时区无效的已按当前时区放，不带）
  const tz = ownTzOf(row.tz, current);
  const origin = tz !== current && row.time !== null && time !== row.time ? { tz, time: row.time } : null;
  return { ...base, allDay: false, start: p.startMs, end: p.endMs, time, origin };
}

/** 某一天的日程（R-444：跨天的它占的每一天都算，含前几天开始、今天还没完的）：全天的在前，有时刻的按开始先后 */
export function eventsOn(rows: readonly Row[], day: DateStr, current: Tz, locale: Locale = 'zh-CN'): EventOcc[] {
  const byTitle = titleCompare(locale);
  const out: EventOcc[] = [];
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const o = eventOcc(r, current);
    if (o && coversDay(o, day)) out.push(o);
  }
  return out.sort((a, b) => (a.start ?? -Infinity) - (b.start ?? -Infinity) || byTitle(a.title, b.title));
}

/** 今天页日程行在 day 这一天怎么写（R-444 跨天：同日清单，event-span.ts 的 spanTextOn） */
export function eventSpanText(o: EventOcc, day: DateStr, current: Tz): SpanText {
  return spanTextOn(o.place, day, current);
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
  /** 项目色序号（nxt 左边竖条的颜色，和列表、日历同一个 projectColorIndex；0 = 没有项目） */
  pc: ProjectColor;
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

/** 细底线的一段（只在一条轨道时画）：x0、x1 是 0～1 的位置，gapL、gapR 这一端挨着色块、要让出 3px（视觉稿 kRuler，R-131 追问“细轨只画在色块之间，碰到色块就断开”） */
export interface NowTrk {
  x0: number;
  x1: number;
  gapL: boolean;
  gapR: boolean;
}

/** 照视觉稿 kRuler：色块按左端排好，色块之间、两头空着的地方各画一段底线 */
function trkPieces(segs: readonly NowSeg[]): NowTrk[] {
  const out: NowTrk[] = [];
  let x = 0;
  let first = true;
  for (const s of [...segs].sort((a, b) => a.x0 - b.x0)) {
    if (s.x0 > x + 0.005) out.push({ x0: x, x1: s.x0, gapL: !first, gapR: true });
    x = Math.max(x, s.x1);
    first = false;
  }
  if (x < 0.995) out.push({ x0: x, x1: 1, gapL: !first, gapR: false });
  return out;
}

/** “现在”卡要画的全部数：界面只拼文案、查表，不再自己算时间（R-423 整块评审第 7、10、11 条） */
export interface NowCard {
  state: NowState;
  /** 此刻的墙上时间 HH:MM（按时区换算，不靠“离 0 点几分钟”，夏令时那天也对；秒数直接舍去） */
  nowText: string;
  /** 正在进行几件（live；页头“进行中 N 件”） */
  liveN: number;
  /** 标题行：live 第一件的标题、idle 下一件的标题；其余为 null，界面写暖心句 */
  title: string | null;
  /** idle 时标题前的开始时刻（界面用数字字体，视觉稿 kcard 的 .num）；其余为 null */
  time: string | null;
  /** 页头右边的分钟数：live 第一件还剩几分、idle 几分后开始；其余为 null（far 的“几分后”只在卡底写一次） */
  left: number | null;
  /** live 第二件：一件写“同时：标题 · 到 HH:MM · 还剩”，三件及以上写“同时还有 N 件” */
  also: { title: string; end: string; left: number } | { more: number } | null;
  /** 下一件（有就给）：live 且下一件在时间尺里时，界面只给读屏写一句“下一件 …”（时间尺 aria-hidden，复审第 4 条） */
  next: { time: string; title: string; inMin: number } | null;
  /** 时间尺下面一行：下一件在窗口外写一次“下一件 …”；done 时写明天的第一件 */
  foot: { kind: 'next'; time: string; title: string; inMin: number } | { kind: 'tomorrow'; time: string; title: string } | null;
  /** allday：第一件全天日程的标题和件数（页头“全天 · 休假”） */
  allDay: { title: string; n: number } | null;
  /** 时间尺：轨道数、此刻竖线的位置、色块、刻度 */
  ruler: { lanes: 1 | 2; mark: number; segs: NowSeg[]; trk: NowTrk[]; ticks: NowTick[] };
}

/** 有开始、结束时刻的日程（全天的没有）；类型上收窄，后面不用再写 ?? 兜底 */
type TimedOcc = EventOcc & { start: number; end: number; time: string };
const isTimed = (o: EventOcc): o is TimedOcc => !o.allDay && o.start !== null && o.end !== null && o.time !== null;

/** 明天的日程离此刻多近才算“下一件”：和 kWin ② 同一个口径（3 小时以内的下一件画进时间尺） */
const SOON_MIN = 180;

/** 喂给“现在”卡的日程：今天的，加上跨零点两头的——
 *  前几天开始、此刻还没结束的（00:30 时仍是“进行中”，整块评审第 4 条；R-444 跨多天的同样，eventsOn 已经算进今天，这里去掉今天之前开始、已经结束的）；
 *  明天 3 小时以内开始的（23:45 时明天 00:15 那件是“下一件”，复审第 1 条；只算明天开始的，今天开始跨进明天的已经在今天里） */
export function nowEvents(rows: readonly Row[], now: number, current: Tz, locale: Locale = 'zh-CN'): EventOcc[] {
  const today = todayOf(now, current);
  const tomorrow = addDays(today, 1);
  const cur = eventsOn(rows, today, current, locale).filter((o) => o.date === today || !isTimed(o) || o.end > now);
  const soon = eventsOn(rows, tomorrow, current, locale).filter((o) => isTimed(o) && o.date === tomorrow && o.start - now <= SOON_MIN * MIN);
  return [...cur, ...soon];
}

/** 日程 → “现在”卡；today 是当前时区的今天；tomorrowFirst 是明天第一件带时刻的日程（done 时写在卡底） */
export function nowCard(events: readonly EventOcc[], now: number, current: Tz, today: DateStr = todayOf(now, current), tomorrowFirst: EventOcc | null = null): NowCard {
  const zero = msAt(today, 0, current);
  const off = (ms: number) => (ms - zero) / MIN;
  const span = (o: TimedOcc): Span => ({ s: off(o.start), e: off(o.end) });
  const untilMin = (ms: number) => Math.ceil((ms - now) / MIN);
  const hmOf = (ms: number) => fmtHm(minOfDay(ms, current));

  // 负责人 11-17：多天的有时刻日程（lastDate ≠ date 且时长满 24 小时，R-444）不占大卡——不进 cur、不当 c0，也不算下一件，只在“今天的安排”列表里写“第 2/3 天 · 至 …”；
  // 跨零点但不满 24 小时的（23:30 到 01:00 的夜班）照常占大卡（主持人 11-17 定）。大卡照旧给真正的下一件；
  // 算 state 时多天日程当全天日程（第三轮复审必改 1）：今天只有它时走 allday、标题写它，不写“今天没有日程”；同时有真正的全天日程时排在后面，按 allday 原规则取第一条
  const multi = (o: EventOcc): o is TimedOcc => isTimed(o) && o.lastDate !== o.date && o.end - o.start >= DAY_MINUTES * MIN;
  const timed = events.filter((o): o is TimedOcc => isTimed(o) && !multi(o));
  const allDays = [...events.filter((o) => o.allDay), ...events.filter(multi)];
  const cur = timed.filter((o) => o.start <= now && now < o.end).sort((a, b) => a.end - b.end);
  const next = timed.filter((o) => o.start > now).sort((a, b) => a.start - b.start)[0] ?? null;
  const nowM = off(now);
  const win = kWin(cur.map(span), next ? span(next) : null, nowM);
  const nextFar = next !== null && span(next).s >= win.B;
  const [c0, c1] = cur;
  const state: NowState = c0 ? 'live' : next ? (nextFar ? 'far' : 'idle') : timed.length ? 'done' : allDays.length ? 'allday' : 'empty';

  const X = (min: number) => (Math.min(Math.max(min, win.A), win.B) - win.A) / (win.B - win.A);
  const seg = (o: TimedOcc | null | undefined, kind: NowSeg['kind'], lane: 0 | 1): NowSeg | null => {
    if (!o) return null;
    const { s, e } = span(o);
    if (e <= win.A || s >= win.B) return null;
    const p = Math.max(s, win.A);
    const q = Math.min(e, win.B);
    const done = kind === 'nxt' ? 0 : Math.max(0, Math.min(1, (nowM - p) / (q - p)));
    return { kind, id: o.id, label: o.project || o.title, pc: projectColorIndex(o.project), lane, x0: X(s), x1: X(e), clipL: s < win.A, clipR: e > win.B, done };
  };
  const segs = [seg(c0, 'cur', 0), seg(c1, 'co', 1), seg(next, 'nxt', 0)].filter((x): x is NowSeg => x !== null);
  const ticks: NowTick[] = [];
  for (let t = Math.ceil(win.A / 60) * 60; t <= win.B; t += 60) {
    ticks.push({ x: X(t), text: `${Math.floor(minOfDay(zero + t * MIN, current) / 60)}:00`, edge: t === win.A ? 'l' : t === win.B ? 'r' : null });
  }

  const nx = next ? { time: next.time, title: next.title, inMin: untilMin(next.start) } : null;

  return {
    state,
    nowText: hmOf(now),
    liveN: cur.length,
    title: c0 ? c0.title : state === 'idle' && next ? next.title : null,
    time: !c0 && state === 'idle' && next ? next.time : null,
    left: c0 ? untilMin(c0.end) : state === 'idle' && next ? untilMin(next.start) : null,
    next: nx,
    also: cur.length > 2 ? { more: cur.length - 1 } : c1 ? { title: c1.title, end: hmOf(c1.end), left: untilMin(c1.end) } : null,
    foot:
      nx && nextFar
        ? { kind: 'next', ...nx }
        : state === 'done' && tomorrowFirst?.time
          ? { kind: 'tomorrow', time: tomorrowFirst.time, title: tomorrowFirst.title }
          : null,
    allDay: state === 'allday' && allDays[0] ? { title: allDays[0].title, n: allDays.length } : null,
    ruler: { lanes: c1 ? 2 : 1, mark: X(nowM), segs, trk: c1 ? [] : trkPieces(segs), ticks },
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

/** 没赶上：没完成，截止日早于今天，或今天的截止时刻已过；先后按 compareTodos（R-442：H → M → L，同档截止早的在前，再按创建时间）；
 *  keep 里的（刚勾完、还留在原位的）照没完成算（shared/logic/todo-row.ts 的 lingerView），收起以前留在这一组 */
export function lateTodos(rows: readonly Row[], now: number, current: Tz, keep: ReadonlySet<string> = NONE): Late[] {
  const today = todayOf(now, current);
  const out: Late[] = [];
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (t.due && isLate(lingerView(t, keep), now, current)) out.push({ todo: t, days: diffDays(t.due, today) });
  }
  return out.sort((a, b) => compareTodos(a.todo, b.todo));
}

/** 今天截止、还没过的待办（过了的进“没赶上”）：没完成的在前（做完的收进“已过去”），其余按 compareTodos（R-442：H → M → L，同档按截止时刻、没时刻的在后，再按创建时间）；
 *  keep 里的（刚勾完、还留在原位的）照没完成排、照没完成判断过没过时刻（lingerView，和 lateTodos 同一个口径：已过时刻的只在“没赶上”） */
export function todayTodos(rows: readonly Row[], now: number, current: Tz, keep: ReadonlySet<string> = NONE): TodoOcc[] {
  const today = todayOf(now, current);
  const out: TodoOcc[] = [];
  for (const r of rows) {
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (t.due === today && !isLate(lingerView(t, keep), now, current)) out.push(t);
  }
  const done = (t: TodoOcc): number => Number(lingerView(t, keep).done);
  return out.sort((a, b) => done(a) - done(b) || compareTodos(a, b));
}

// ---------- 已过去 ----------

/** 今天的安排里“已过去”的（定稿线框 s1“已过去的折叠成一行”，时间河 river()“▸ 已过去 2 件：10:30 SignPlex 字幕校对 · 买咖啡豆 ✓”）：
 *  有时刻、结束不晚于此刻的日程，和做完的待办；全天日程不算（没有结束时刻）。其余的照原顺序留在列表里；
 *  keep 里的待办（刚勾完、还留在原位的）收起以前不算已过去 */
export function splitPast<E extends Pick<EventOcc, 'end'>, T extends Pick<TodoOcc, 'id' | 'done'>>(
  events: readonly E[],
  todos: readonly T[],
  now: number,
  keep: ReadonlySet<string> = NONE,
): { pastEvents: E[]; pastTodos: T[]; events: E[]; todos: T[] } {
  const ended = (o: E): boolean => o.end !== null && o.end <= now;
  const past = (t: T): boolean => lingerView(t, keep).done;
  return {
    pastEvents: events.filter(ended),
    pastTodos: todos.filter(past),
    events: events.filter((o) => !ended(o)),
    todos: todos.filter((t) => !past(t)),
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

