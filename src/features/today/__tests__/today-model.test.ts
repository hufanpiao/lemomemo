// 今天页的纯逻辑（data/today-model.ts；架构 4.6；皮肤视觉稿“现在”卡 K 的时间窗规则）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { eventOcc, eventsOn, kWin, lateTodos, nowCard, splitDur, todayTodos, type Row } from '../data/today-model.ts';

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

describe('“现在”卡四种状态', () => {
  const day = (rows: Row[]) => eventsOn(rows, DAY, SEOUL);

  it('① 进行中：还剩 13 分钟；两件同时进行时按结束先后', () => {
    const rows = [ev({ time: '14:00', tz: SEOUL, duration_min: 30 }), ev({ time: '13:30', tz: SEOUL, duration_min: 90 }), ev({ time: '15:30', tz: SEOUL })];
    const c = nowCard(day(rows), at('14:17'), SEOUL);
    if (c.state !== 'live') throw new Error(c.state);
    expect(c.cur.map((o) => o.time)).toEqual(['14:00', '13:30']);
    expect(c.leftMin).toBe(13);
    expect(c.next?.time).toBe('15:30');
    expect(c.win).toEqual({ A: m('13:00'), B: m('16:30') });
    expect(c.nextOutside).toBe(false);
  });

  it('② 没有进行中、今天还有下一件：1 小时 13 分后', () => {
    const c = nowCard(day([ev({ time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL);
    if (c.state !== 'idle') throw new Error(c.state);
    expect(c.inMin).toBe(73);
    expect(splitDur(c.inMin)).toEqual({ h: 1, m: 13 });
  });

  it('② 下一件在时间窗外（3 小时以后）：时间轴下面另写一行', () => {
    const c = nowCard(day([ev({ time: '18:00', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c).toMatchObject({ state: 'idle', nextOutside: true, win: { A: m('13:30'), B: m('16:30') } });
  });

  it('③ 今天的都结束了；只有全天的也算 ③；④ 今天没有日程', () => {
    expect(nowCard(day([ev({ time: '09:00', tz: SEOUL })]), at('21:40'), SEOUL)).toEqual({ state: 'done' });
    expect(nowCard(day([ev({ time: null })]), at('09:05'), SEOUL)).toEqual({ state: 'done' });
    expect(nowCard([], at('09:05'), SEOUL)).toEqual({ state: 'empty' });
  });

  it('全天事项不算进行中、不进时间轴', () => {
    const c = nowCard(day([ev({ time: null }), ev({ time: '15:30', tz: SEOUL })]), at('14:17'), SEOUL);
    expect(c.state).toBe('idle');
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
