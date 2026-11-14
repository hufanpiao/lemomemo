// 今天页的纯逻辑（data/today-model.ts；架构 4.6；皮肤视觉稿“现在”卡 K 的时间窗规则）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { eventOcc, eventsOn, kWin, lateTodos, nowCard, nowEvents, splitDur, splitPast, todayTodos, type Row } from '../data/today-model.ts';

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
    expect(eventsOn([r], DAY, SH)).toEqual([]);
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
      { kind: 'cur', id: short.id, label: '短会', lane: 0, x0: 60 / W, x1: 90 / W, clipL: false, clipR: false, done: expect.closeTo(17 / 30) },
      { kind: 'co', id: long.id, label: '长会', lane: 1, x0: 30 / W, x1: 120 / W, clipL: false, clipR: false, done: expect.closeTo(47 / 90) },
      { kind: 'nxt', id: shop.id, label: '逛街', lane: 0, x0: 150 / W, x1: 1, clipL: false, clipR: false, done: 0 },
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

  it('② idle：下一件在时间尺里，标题“开始时刻 标题”、1 小时 13 分后；卡底不重复写', () => {
    const c = nowCard(day([ev({ title: '逛街', time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'idle', title: '15:30 逛街', left: 73, also: null, foot: null });
    expect(splitDur(73)).toEqual({ h: 1, m: 13 });
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

  it('跨零点：昨天 23:30 开始、到 01:00 的日程，00:30 时仍是“进行中”；时间尺从昨天 23:00 起', () => {
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
    expect(c).toMatchObject({ state: 'idle', nowText: '08:00', title: '09:00 早餐', left: 60 });
    const t8 = c.ruler.ticks.find((k) => k.text === '8:00');
    expect(t8?.x).toBeCloseTo(c.ruler.mark);
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
