// 今天页的纯逻辑（data/today-model.ts；架构 4.6；皮肤视觉稿“现在”卡 K 的时间窗规则）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import { eventOcc, eventSpanText, eventsOn, kWin, lateTodos, nowCard, nowEvents, splitPast, todayTodos, type Row } from '../data/today-model.ts';

const SEOUL = 'Asia/Seoul';
const SH = 'Asia/Shanghai';
const DAY = '2026-11-05';
const at = (hm: string, tz = SEOUL, day = DAY) => msAt(day, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), tz);
const m = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

let n = 0;
const ev = (over: Record<string, unknown>): Row => ({
  id: `e${++n}`, title: `日程${n}`, project: '', date: DAY, time: null, tz: null, duration_min: 60, deleted_at: null, undone: false, ...over,
});
const td = (over: Record<string, unknown>): Row => ({
  id: `t${++n}`, title: `待办${n}`, project: '', done: false, important: false, due: null, due_time: null, deleted_at: null, undone: false, ...over,
});

describe('kWin：照视觉稿 kWin() 的四条', () => {
  it('① 有进行中：开始前半小时 → 下一件结束；两端取整到半点', () => {
    // 14:00–14:30 进行中，下一件 15:30–16:10，此刻 14:17
    expect(kWin([{ s: m('14:00'), e: m('14:30') }], { s: m('15:30'), e: m('16:10') }, m('14:17'))).toEqual({ A: m('13:30'), B: m('16:30') });
  });

  it('① 下一件离当前结束超过 2 小时：只画到当前结束后半小时', () => {
    expect(kWin([{ s: m('14:00'), e: m('14:30') }], { s: m('16:31'), e: m('17:00') }, m('14:17'))).toEqual({ A: m('13:30'), B: m('15:00') });
  });

  it('② 没有进行中：此刻前半小时 → 下一件结束；下一件 3 小时以后才开始：此刻到 2 小时后', () => {
    expect(kWin([], { s: m('15:30'), e: m('16:30') }, m('14:17'))).toEqual({ A: m('13:30'), B: m('16:30') });
    expect(kWin([], { s: m('17:18'), e: m('18:00') }, m('14:17'))).toEqual({ A: m('13:30'), B: m('16:30') });
  });

  it('③ 取整：12:47 → 12:30，16:10 → 16:30', () => {
    expect(kWin([], { s: m('15:40'), e: m('16:10') }, m('13:17'))).toEqual({ A: m('12:30'), B: m('16:30') });
  });

  it('④ 最多 4 小时：从此刻前 1 小时取整开始截；截出的结束超过原结束就整体往前挪', () => {
    // 长会 9:00–18:00，此刻 14:17：A=8:30、B=18:30 超 4 小时 → 从 13:00 截到 17:00
    expect(kWin([{ s: m('09:00'), e: m('18:00') }], null, m('14:17'))).toEqual({ A: m('13:00'), B: m('17:00') });
    // 此刻 17:50：从 16:30 截到 20:30 超过 18:30 → 挪成 14:30–18:30
    expect(kWin([{ s: m('09:00'), e: m('18:00') }], null, m('17:50'))).toEqual({ A: m('14:30'), B: m('18:30') });
  });
});

describe('日程换算（架构 4.6）', () => {
  it('固定时刻：首尔 15:00 的会，人在上海 → 14:00，带“首尔 15:00”', () => {
    const o = eventOcc(ev({ time: '15:00', tz: SEOUL }), SH);
    expect(o).toMatchObject({ date: DAY, time: '14:00', allDay: false, origin: { tz: SEOUL, time: '15:00' } });
    expect(o?.start).toBe(at('15:00'));
    expect(o?.end).toBe(at('16:00'));
  });

  it('跨日：首尔 00:30 在上海是前一天 23:30，放进前一天', () => {
    const r = ev({ time: '00:30', tz: SEOUL });
    expect(eventsOn([r], '2026-11-04', SH).map((o) => o.time)).toEqual(['23:30']);
    // 上海 23:30 起 1 小时，跨过午夜进到 11-05（R-444：跨午夜的两天都算），开始那天仍是 11-04
    expect(eventsOn([r], DAY, SH).map((o) => o.date)).toEqual(['2026-11-04']);
    expect(eventsOn([{ ...r, duration_min: 30 }], DAY, SH)).toEqual([]);
  });

  it('同一时区不加注；全天不换算；坏值不显示', () => {
    expect(eventOcc(ev({ time: '15:00', tz: SEOUL }), SEOUL)?.origin).toBeNull();
    expect(eventOcc(ev({ time: null }), SH)).toMatchObject({ date: DAY, allDay: true, start: null, origin: null });
    expect(eventOcc(ev({ date: 'x' }), SEOUL)).toBeNull();
  });

  it('eventsOn：删了的、撤销的不算；全天在前，按开始先后', () => {
    const rows = [ev({ time: '15:00', tz: SEOUL, title: 'b' }), ev({ time: null, title: 'a' }), ev({ time: '09:00', tz: SEOUL }), ev({ time: '10:00', tz: SEOUL, deleted_at: 1 }), ev({ time: '11:00', tz: SEOUL, undone: true })];
    expect(eventsOn(rows, DAY, SEOUL).map((o) => o.time)).toEqual([null, '09:00', '15:00']);
  });
});

describe('“现在”卡六种状态（模型给数、界面查表）', () => {
  const day = (rows: Row[], d = DAY, tz = SEOUL) => eventsOn(rows, d, tz);
  const W = 210; // 13:00～16:30

  it('① 两件同时进行：按结束先后，第二件在第二条轨道；还剩、此刻竖线、刻度都由模型给', () => {
    const short = ev({ title: '短会', time: '14:00', tz: SEOUL, duration_min: 30 });
    const long = ev({ title: '长会', time: '13:30', tz: SEOUL, duration_min: 90 });
    const shop = ev({ title: '逛街', time: '15:30', tz: SEOUL });
    const c = nowCard(day([short, long, shop]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'live', nowText: '14:17', liveN: 2, title: '短会', left: 13, also: { title: '长会', end: '15:00', left: 43 }, foot: null, allDay: null });
    expect(c.ruler.lanes).toBe(2);
    expect(c.ruler.mark).toBeCloseTo(77 / W);
    expect(c.ruler.trk).toEqual([]);
    expect(c.ruler.segs).toEqual([
      { kind: 'cur', id: short.id, label: '短会', pc: 0, lane: 0, x0: 60 / W, x1: 90 / W, clipL: false, clipR: false, done: expect.closeTo(17 / 30) },
      { kind: 'co', id: long.id, label: '长会', pc: 0, lane: 1, x0: 30 / W, x1: 120 / W, clipL: false, clipR: false, done: expect.closeTo(47 / 90) },
      { kind: 'nxt', id: shop.id, label: '逛街', pc: 0, lane: 0, x0: 150 / W, x1: 1, clipL: false, clipR: false, done: 0 },
    ]);
    expect(c.ruler.ticks).toEqual([
      { x: 0, text: '13:00', edge: 'l' },
      { x: 60 / W, text: '14:00', edge: null },
      { x: 120 / W, text: '15:00', edge: null },
      { x: 180 / W, text: '16:00', edge: null },
    ]);
  });

  it('① 三件同时进行：写“同时还有 2 件”，仍只画两条轨道', () => {
    const rows = [14, 13, 12].map((h) => ev({ time: `${h}:00`, tz: SEOUL, duration_min: 180 }));
    const c = nowCard(day(rows), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'live', liveN: 3, also: { more: 2 } });
    expect(c.ruler.lanes).toBe(2);
    expect(c.ruler.segs.filter((s) => s.kind !== 'nxt')).toHaveLength(2);
  });

  it('此刻带秒数：墙上时刻舍去秒，还剩按整分钟往上取（14:17:59 离 14:30 还剩 13 分钟）', () => {
    const c = nowCard(day([ev({ time: '14:00', tz: SEOUL, duration_min: 30 })]), at('14:17') + 59_000, SEOUL);
    expect(c).toMatchObject({ nowText: '14:17', left: 13 });
  });

  it('占不占大卡的边界：跨零点 1439 分钟（23:30 到次日 23:29）占，1440 分钟（10:00 到次日 10:00）不占', () => {
    const short = ev({ title: '长班', date: '2026-11-04', time: '23:30', tz: SEOUL, duration_min: 1439 });
    expect(nowCard(nowEvents([short], at('14:17'), SEOUL), at('14:17'), SEOUL)).toMatchObject({ state: 'live', title: '长班' });
    const full = ev({ title: '值班', date: '2026-11-04', time: '10:00', tz: SEOUL, duration_min: 1440 });
    expect(nowCard(nowEvents([full], at('09:00'), SEOUL), at('09:00'), SEOUL).state).toBe('empty');
  });

  it('多天的有时刻日程不占大卡（负责人 11-17）：不进 cur、不当 c0，大卡给真正的下一件；今天只有这类日程时按没有带时刻的日程算', () => {
    // 昨天 10:00 开始、明天 10:00 结束的出差：此刻 14:17 正在进行，但大卡不给它
    const trip = ev({ title: '出差', date: '2026-11-04', time: '10:00', tz: SEOUL, duration_min: 2 * 1440 });
    const shop = ev({ title: '逛街', time: '15:30', tz: SEOUL });
    const c = nowCard(day([trip, shop]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'idle', title: '逛街', liveN: 0, also: null, next: { time: '15:30', title: '逛街' } });
    expect(c.ruler.segs.map((s) => s.id)).not.toContain(trip.id);
    // 列表照样有它（“今天的安排”里写第几天）
    expect(day([trip, shop]).map((o) => o.id)).toContain(trip.id);
    // 今天只有多天日程：不算“进行中”，也不算“都结束了”
    expect(nowCard(day([trip]), at('14:17'), SEOUL).state).toBe('empty');
    expect(nowCard(day([trip, ev({ title: '休假', time: null })]), at('14:17'), SEOUL).state).toBe('allday');
  });

  it('② idle：下一件在时间尺里，标题“开始时刻 标题”、1 小时 13 分后；卡底不重复写', () => {
    const c = nowCard(day([ev({ title: '逛街', time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'idle', time: '15:30', title: '逛街', left: 73, also: null, foot: null, next: { time: '15:30', title: '逛街', inMin: 73 } });
    // 底线只画在色块左边，挨着色块那头让出 3px（视觉稿 kRuler）
    expect(nowCard(day([ev({ time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL).ruler.trk).toEqual([{ x0: 0, x1: 2 / 3, gapL: false, gapR: true }]);
  });

  it('② far：下一件在时间尺外（3 小时以后），标题行留给暖心句，“几分后”只在卡底写一次', () => {
    const c = nowCard(day([ev({ title: '逛街', time: '18:00', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'far', title: null, left: null, foot: { kind: 'next', time: '18:00', title: '逛街', inMin: 223 } });
    expect(c.ruler.segs).toEqual([]);
  });

  it('③ done：今天带时刻的都结束了；有明天第一件时写在卡底', () => {
    const rows = [ev({ time: '09:00', tz: SEOUL })];
    expect(nowCard(day(rows), at('21:40'), SEOUL)).toMatchObject({ state: 'done', title: null, left: null, foot: null });
    const [first] = day([ev({ title: '开会', date: '2026-11-06', time: '11:00', tz: SEOUL })], '2026-11-06');
    expect(nowCard(day(rows), at('21:40'), SEOUL, DAY, first)).toMatchObject({ foot: { kind: 'tomorrow', time: '11:00', title: '开会' } });
  });

  it('只有全天日程：allday，页头写第一件和件数；全天的不进时间尺', () => {
    const c = nowCard(day([ev({ title: '休假', time: null })]), at('09:05'), SEOUL);
    expect(c).toMatchObject({ state: 'allday', title: null, allDay: { title: '休假', n: 1 } });
    expect(c.ruler.segs).toEqual([]);
    expect(nowCard(day([ev({ time: null }), ev({ time: null })]), at('09:05'), SEOUL).allDay?.n).toBe(2);
    expect(nowCard(day([ev({ time: null }), ev({ time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL).state).toBe('idle');
  });

  it('④ empty：照样画此刻前后的时间尺（8:30～11:30），刻度小时不补零', () => {
    const c = nowCard([], at('09:05'), SEOUL);
    expect(c).toMatchObject({ state: 'empty', nowText: '09:05', liveN: 0, title: null, left: null, also: null, foot: null, allDay: null });
    expect(c.ruler).toEqual({
      lanes: 1,
      mark: 35 / 180,
      segs: [],
      trk: [{ x0: 0, x1: 1, gapL: false, gapR: false }],
      ticks: [
        { x: 30 / 180, text: '9:00', edge: null },
        { x: 90 / 180, text: '10:00', edge: null },
        { x: 150 / 180, text: '11:00', edge: null },
      ],
    });
  });

  it('跨零点：昨天 23:30 开始、到 01:00 的日程，00:30 时仍是“进行中”（不满 24 小时照常占大卡，主持人 11-17 定）；时间尺从昨天 23:00 起', () => {
    const rows = [ev({ title: '夜班', date: '2026-11-04', time: '23:30', tz: SEOUL, duration_min: 90 })];
    const c = nowCard(nowEvents(rows, at('00:30'), SEOUL), at('00:30'), SEOUL);
    expect(c).toMatchObject({ state: 'live', title: '夜班', left: 30, nowText: '00:30' });
    expect(c.ruler.segs[0]).toMatchObject({ kind: 'cur', x0: 30 / 150, x1: 120 / 150, clipL: false, clipR: false });
    expect(c.ruler.ticks.map((k) => k.text)).toEqual(['23:00', '0:00', '1:00']);
    // 已经结束的昨天日程不带进来
    expect(nowEvents(rows, at('01:10'), SEOUL)).toEqual([]);
  });

  it('夏令时结束那天（纽约 11-01 凌晨 2 点拨回 1 点）：墙上时刻、刻度、此刻竖线都按当地时间', () => {
    const NY = 'America/New_York';
    const D = '2026-11-01';
    const now = at('08:00', NY, D);
    const c = nowCard(day([ev({ title: '早餐', date: D, time: '09:00', tz: NY })], D, NY), now, NY, D);
    expect(c).toMatchObject({ state: 'idle', nowText: '08:00', time: '09:00', title: '早餐', left: 60 });
    const t8 = c.ruler.ticks.find((k) => k.text === '8:00');
    expect(t8?.x).toBeCloseTo(c.ruler.mark);
  });
  it('④ 一件长日程超过 4 小时：时间尺截成 13:00～17:00，色块两头都被截断，最后一个刻度贴右边', () => {
    const c = nowCard(day([ev({ time: '09:00', tz: SEOUL, duration_min: 540 })]), at('14:17'), SEOUL);
    expect(c.ruler.segs[0]).toMatchObject({ kind: 'cur', x0: 0, x1: 1, clipL: true, clipR: true });
    expect(c.ruler.ticks[0]).toEqual({ x: 0, text: '13:00', edge: 'l' });
    expect(c.ruler.ticks.at(-1)).toEqual({ x: 1, text: '17:00', edge: 'r' });
    // 色块占满整条，底线一段都不画
    expect(c.ruler.trk).toEqual([]);
  });

  it('底线分段：色块在中间时两头各一段、挨着色块那头让出；首尾相接的两块之间不画', () => {
    const mid = nowCard(day([ev({ time: '14:00', tz: SEOUL, duration_min: 30 })]), at('14:17'), SEOUL);
    expect(mid.ruler.trk.map((k) => [k.gapL, k.gapR])).toEqual([
      [false, true],
      [true, false],
    ]);
    const joined = nowCard(day([ev({ time: '14:00', tz: SEOUL, duration_min: 90 }), ev({ time: '15:30', tz: SEOUL, duration_min: 30 })]), at('14:17'), SEOUL);
    const [cur, nxt] = joined.ruler.segs;
    expect(cur?.x1).toBe(nxt?.x0);
    expect(joined.ruler.trk.every((k) => k.x1 <= (cur?.x0 ?? 0) || k.x0 >= (nxt?.x1 ?? 1))).toBe(true);
  });

  it('far 和时间尺的分界：下一件正好在时间尺右端开始，算在尺外（卡底写一次，尺上不画）', () => {
    const c = nowCard(day([ev({ time: '09:00', tz: SEOUL, duration_min: 540 }), ev({ title: '晚饭', time: '17:00', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'live', foot: { kind: 'next', time: '17:00', title: '晚饭' } });
    expect(c.ruler.segs.map((s) => s.kind)).toEqual(['cur']);
  });

  it('下一件的项目色：和列表、日历同一个 projectColorIndex；没有项目是 0', () => {
    const c = nowCard(day([ev({ title: '逛街', project: 'NEOX', time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c.ruler.segs[0]).toMatchObject({ kind: 'nxt', label: 'NEOX', pc: projectColorIndex('NEOX') });
    expect(projectColorIndex('NEOX')).toBeGreaterThan(0);
  });

  it('快到零点：明天 3 小时以内开始的是“下一件”、画进时间尺；再晚的不算', () => {
    const tmr = '2026-11-06';
    const rows = [ev({ time: '09:00', tz: SEOUL }), ev({ title: '夜宵', date: tmr, time: '00:15', tz: SEOUL })];
    const now = at('23:45');
    const c = nowCard(nowEvents(rows, now, SEOUL), now, SEOUL);
    expect(c).toMatchObject({ state: 'idle', time: '00:15', title: '夜宵', left: 30, foot: null });
    expect(c.ruler.segs.map((s) => s.kind)).toEqual(['nxt']);
    expect(c.ruler.ticks.map((k) => k.text)).toContain('0:00');
    // 今天没有日程也一样
    expect(nowCard(nowEvents([rows[1] as Row], now, SEOUL), now, SEOUL).state).toBe('idle');
    // 明天 03:30 开始（3 小时 45 分后）的不带进来，今天没有就是 empty
    expect(nowEvents([ev({ date: tmr, time: '03:30', tz: SEOUL })], now, SEOUL)).toEqual([]);
  });

  it('夏令时开始那天（纽约 3-08 凌晨 2 点拨到 3 点）：刻度跳过 2:00，还剩按真实分钟算', () => {
    const NY = 'America/New_York';
    const D = '2026-03-08';
    const now = at('01:30', NY, D);
    const c = nowCard(day([ev({ title: '早班', date: D, time: '03:30', tz: NY })], D, NY), now, NY, D);
    expect(c).toMatchObject({ state: 'idle', nowText: '01:30', time: '03:30', left: 60 });
    expect(c.ruler.ticks.map((k) => k.text)).toEqual(['1:00', '3:00', '4:00']);
  });
});

describe('待办：没赶上、今天', () => {
  const now = at('14:17');

  it('没赶上：截止日早于今天（逾 N 天）、今天截止时刻已过（逾 0 天）；完成的、删了的、没日期的不算；逾得久的在前', () => {
    const rows = [
      td({ due: '2026-11-04', title: 'a' }), td({ due: '2026-11-02', title: 'b' }), td({ due: DAY, due_time: '12:00', title: 'c' }),
      td({ due: DAY, due_time: '17:00' }), td({ due: '2026-11-01', done: true }), td({ due: '2026-11-01', deleted_at: 1 }), td({ due: null }),
    ];
    expect(lateTodos(rows, now, SEOUL).map((l) => [l.todo.title, l.days])).toEqual([['b', 3], ['a', 1], ['c', 0]]);
  });

  it('今天：截止时刻还没到的、没有时刻的；过了时刻的进“没赶上”；没完成的在前、按截止时刻', () => {
    const rows = [td({ due: DAY, title: 'x' }), td({ due: DAY, due_time: '17:00', title: 'y' }), td({ due: DAY, due_time: '12:00' }), td({ due: DAY, due_time: '12:00', done: true, title: 'z' })];
    expect(todayTodos(rows, now, SEOUL).map((t) => t.title)).toEqual(['y', 'x', 'z']);
  });

  it('待办截止是浮动的：按 current_tz 判断（人在上海，17:00 截止按上海的 17:00）', () => {
    const r = td({ due: DAY, due_time: '17:00' });
    expect(lateTodos([r], at('16:30', SH), SH)).toEqual([]);
    expect(lateTodos([r], at('17:00', SH), SH)).toHaveLength(1);
  });
});

describe('同一时刻按标题排：数字按数值（设计审查：长列表“第 1、10、11 … 2、20”）', () => {
  const titles = (ts: string[]) => ts.map((title) => td({ title, due: DAY }));
  const shuffled = (a: string[]) => [a[3], a[0], a[2], a[1]] as string[];

  it('今天的待办：中文 1、2、10、20', () => {
    const want = ['第 1 条：整理清单', '第 2 条：整理清单', '第 10 条：整理清单', '第 20 条：整理清单'];
    expect(todayTodos(titles(shuffled(want)), at('08:00'), SEOUL, 'zh-CN').map((t) => t.title)).toEqual(want);
  });

  it('今天的待办：韩文 1、2、10、20', () => {
    const want = ['할 일 1', '할 일 2', '할 일 10', '할 일 20'];
    expect(todayTodos(titles(shuffled(want)), at('08:00'), SEOUL, 'ko-KR').map((t) => t.title)).toEqual(want);
  });

  it('没赶上的待办、同一时刻的日程也一样；排序口径不变（标题仍是最后一道）', () => {
    const late = ['报表 1', '报表 2', '报表 10', '报表 20'].map((title) => td({ title, due: '2026-11-04' }));
    expect(lateTodos([late[3]!, late[0]!, late[2]!, late[1]!], at('08:00'), SEOUL, 'zh-CN').map((l) => l.todo.title)).toEqual(['报表 1', '报表 2', '报表 10', '报表 20']);
    const evs = ['회의 1', '회의 2', '회의 10', '회의 20'].map((title) => ev({ title, time: '09:00', tz: SEOUL }));
    expect(eventsOn([evs[3]!, evs[0]!, evs[2]!, evs[1]!], DAY, SEOUL, 'ko-KR').map((o) => o.title)).toEqual(['회의 1', '회의 2', '회의 10', '회의 20']);
    // 时刻仍然先比：10:00 的“第 1 条”排在 09:00 的“第 20 条”后面
    const mixed = [td({ title: '第 1 条', due: DAY, due_time: '10:00' }), td({ title: '第 20 条', due: DAY, due_time: '09:00' })];
    expect(todayTodos(mixed, at('08:00'), SEOUL, 'zh-CN').map((t) => t.title)).toEqual(['第 20 条', '第 1 条']);
  });
});


describe('已过去（线框 s1“已过去的折叠成一行”）：结束了的日程、做完的待办折起来，其余照原顺序', () => {
  it('结束 ≤ 此刻的日程算已过去，正在进行的、全天的不算；做完的待办算已过去', () => {
    const evs = eventsOn(
      [ev({ id: 'a', time: '09:00', tz: SEOUL, duration_min: 60 }), ev({ id: 'b', time: '10:30', tz: SEOUL, duration_min: 60 }), ev({ id: 'c' }), ev({ id: 'd', time: '15:00', tz: SEOUL })],
      DAY,
      SEOUL,
    );
    const tds = todayTodos([td({ id: 'x', due: DAY, done: true }), td({ id: 'y', due: DAY })], at('08:00'), SEOUL);
    // 此刻 11:00：a（9:00–10:00）结束了；b（10:30–11:30）进行中；c 全天；d 还没到。正好 10:00 结束的也算已过去
    const s = splitPast(evs, tds, at('11:00'));
    expect(s.pastEvents.map((o) => o.id)).toEqual(['a']);
    expect(s.events.map((o) => o.id)).toEqual(['c', 'b', 'd']);
    expect(s.pastTodos.map((t) => t.id)).toEqual(['x']);
    expect(s.todos.map((t) => t.id)).toEqual(['y']);
    expect(splitPast(evs, [], at('10:00')).pastEvents.map((o) => o.id)).toEqual(['a']);
    expect(splitPast(evs, [], at('09:59')).pastEvents).toEqual([]);
  });
});

describe('跨天日程（R-444）', () => {
  it('全天 3 天：开始那天到最后一天都在今天的清单里，第 2 天写“第 2/3 天”', () => {
    const r = ev({ duration_min: 3 * 1440 });
    expect(['2026-11-04', DAY, '2026-11-06', '2026-11-07', '2026-11-08'].map((d) => eventsOn([r], d, SEOUL).length)).toEqual([0, 1, 1, 1, 0]);
    const o = eventsOn([r], '2026-11-06', SEOUL)[0];
    expect(o && eventSpanText(o, '2026-11-06', SEOUL)).toEqual({ lead: { key: 'span.allDay', params: {} }, endMin: null, meta: { key: 'span.dayOf', params: { i: 2, n: 3 } } });
  });

  it('有时刻 09:00 起 50 小时：中间那天写“持续”，最后一天写“至 11:00”；超过 31 天的坏值按 1 小时', () => {
    const r = ev({ time: '09:00', tz: SEOUL, duration_min: 50 * 60 });
    expect([DAY, '2026-11-06', '2026-11-07', '2026-11-08'].map((d) => eventsOn([r], d, SEOUL).length)).toEqual([1, 1, 1, 0]);
    const lead = (d: string) => { const o = eventsOn([r], d, SEOUL)[0]; return o && eventSpanText(o, d, SEOUL).lead; };
    expect([DAY, '2026-11-06', '2026-11-07'].map(lead)).toEqual(['start', { key: 'span.ongoing', params: {} }, { key: 'span.until', params: { t: '11:00' } }]);
    expect(eventOcc(ev({ time: '09:00', tz: SEOUL, duration_min: 31 * 1440 + 1 }), SEOUL)?.end).toBe(at('10:00'));
  });

  it('回落规则和日历同一套（评审第 13 条）：时区名无效按当前时区照样显示（原来今天页不显示、日历照显示）；时刻坏了不显示；时长 0 按 1 小时', () => {
    expect(eventOcc(ev({ time: '09:00', tz: 'Foo/Bar' }), SEOUL)).toMatchObject({ date: DAY, time: '09:00', start: at('09:00'), origin: null });
    expect(eventOcc(ev({ time: '9点', tz: SEOUL }), SEOUL)).toBeNull();
    expect(eventOcc(ev({ time: '09:00', tz: SEOUL, duration_min: 0 }), SEOUL)?.end).toBe(at('10:00'));
  });

  it('nowEvents：前天开始、此刻还没完的带进来；已经结束的不带，明天才结束的今天开始的不重复；多天的不占大卡（负责人 11-17）', () => {
    const long = ev({ date: '2026-11-03', time: '20:00', tz: SEOUL, duration_min: 3 * 1440 });   // 11-03 20:00 → 11-06 20:00
    const over = ev({ date: '2026-11-04', time: '23:00', tz: SEOUL, duration_min: 90 });          // 11-04 23:00 → 11-05 00:30
    const late = ev({ time: '23:00', tz: SEOUL, duration_min: 120 });                             // 11-05 23:00 → 11-06 01:00
    const ids = nowEvents([long, over, late], at('10:00'), SEOUL).map((o) => o.id);
    expect(ids).toEqual([long.id, late.id]);
    expect(nowCard(nowEvents([long], at('10:00'), SEOUL), at('10:00'), SEOUL).state).toBe('empty');
  });
});
