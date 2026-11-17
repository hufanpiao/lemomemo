// R-444 跨天日程：shared/logic/calendar/event-span.ts，以及月历（buildMonth）、单日清单（dayEntries）、周视图（buildWeek）都认跨天
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../shared/core/date.ts';
import { dayEntries, placeEvent } from '../../../shared/logic/calendar/cal-items.ts';
import { allDaySpanDays, contOn, spanDaysIn, spanTextOn, timedDurationMin } from '../../../shared/logic/calendar/event-span.ts';
import { buildMonth } from '../../../shared/logic/calendar/month-grid.ts';
import { buildWeek } from '../../../shared/logic/calendar/week-view.ts';
import { EVENT_DURATION_MAX, eventsWrite } from '../../../shared/schema/rows.ts';
import { ev, timed } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const SH = 'Asia/Shanghai';
const DAY = 1440;

describe('event-span：数据做法（duration_min，最多 31 天）', () => {
  it('全天日程：≤ 1440 都算一天（旧行、默认 60），多出来的按整天往上取，最多 31 天', () => {
    expect([60, 1440, 1441, 2 * DAY, 3 * DAY, 40 * DAY, Number.NaN].map(allDaySpanDays)).toEqual([1, 1, 2, 2, 3, 31, 1]);
  });

  it('有时刻的日程：坏值按 0，超过 31 天截到上限', () => {
    expect([90, -5, Number.NaN, EVENT_DURATION_MAX + 1].map(timedDurationMin)).toEqual([90, 0, 0, EVENT_DURATION_MAX]);
  });

  it('zod：1～44640 合格，0、44641 不合格（同库约束 events_duration_min_check）', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001', title: 't', date: '2026-11-17', time: '09:00', tz: SEOUL, project: '', note: '', source: 'page',
      raw_text: '', location: '', short: null, short_by: null, push_show_title: null, batch_id: null, remind_min: 15, remind_days: null,
      notified_for: null, snooze_at: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1,
    };
    expect([1, 1440, 4320, 44640, 0, 44641].map((d) => eventsWrite.safeParse({ ...row, duration_min: d }).success)).toEqual([true, true, true, true, false, false]);
  });

  it('placeEvent：全天的最后一天按天数；有时刻的按结束前那一刻，正好在午夜结束的算前一天', () => {
    expect(placeEvent(ev({ id: 'a', date: '2026-11-18', duration_min: 3 * DAY }), SEOUL)).toEqual({ allDay: true, date: '2026-11-18', lastDate: '2026-11-20' });
    expect(placeEvent(timed('b', '2026-11-18', '09:00', SEOUL, 2 * DAY + 9 * 60), SEOUL)).toMatchObject({ date: '2026-11-18', lastDate: '2026-11-20' });
    expect(placeEvent(timed('c', '2026-11-18', '22:00', SEOUL, 120), SEOUL)).toMatchObject({ lastDate: '2026-11-18' });
    expect(placeEvent(timed('d', '2026-11-18', '22:00', SEOUL, 0), SEOUL)).toMatchObject({ lastDate: '2026-11-18' });
  });

  it('contOn、spanDaysIn：第一天 end、中间 both、最后一天 start；只占一天的 undefined', () => {
    const s = { date: '2026-11-18', lastDate: '2026-11-20' };
    expect(['2026-11-18', '2026-11-19', '2026-11-20'].map((d) => contOn(s, d))).toEqual(['end', 'both', 'start']);
    expect(contOn({ date: '2026-11-18', lastDate: '2026-11-18' }, '2026-11-18')).toBeUndefined();
    expect(spanDaysIn(s, '2026-11-19', '2026-11-30')).toEqual(['2026-11-19', '2026-11-20']);
    expect(spanDaysIn(s, '2026-11-21', '2026-11-30')).toEqual([]);
  });

  it('spanTextOn：开始那天写开始时刻 + “至哪天几点”；中间“持续”；最后一天“至 HH:MM”；全天写第几天', () => {
    const start = msAt('2026-11-18', 9 * 60, SEOUL);
    const t = { date: '2026-11-18', lastDate: '2026-11-20', endMs: start + (2 * DAY + 9 * 60) * 60_000 };
    expect(spanTextOn(t, '2026-11-18', SEOUL)).toEqual({ lead: 'start', endMin: DAY, meta: { kind: 'untilDate', date: '2026-11-20', endMin: 18 * 60 } });
    expect(spanTextOn(t, '2026-11-19', SEOUL)).toEqual({ lead: 'ongoing', endMin: DAY, meta: { kind: 'untilDate', date: '2026-11-20', endMin: 18 * 60 } });
    expect(spanTextOn(t, '2026-11-20', SEOUL)).toEqual({ lead: 'until', endMin: 18 * 60, meta: null });
    expect(spanTextOn({ date: '2026-11-18', lastDate: '2026-11-18', endMs: start + 60 * 60_000 }, '2026-11-18', SEOUL)).toEqual({ lead: 'start', endMin: 600, meta: null });
    const a = { date: '2026-11-18', lastDate: '2026-11-20', endMs: null };
    expect(spanTextOn(a, '2026-11-19', SEOUL)).toEqual({ lead: 'allDay', endMin: null, meta: { kind: 'dayOf', index: 2, days: 3 } });
    expect(spanTextOn({ ...a, lastDate: '2026-11-18' }, '2026-11-18', SEOUL).meta).toBeNull();
  });
});

describe('月历、单日清单：跨天的日程它占的每一天都有', () => {
  const events = [
    ev({ id: 'trip', date: '2026-11-18', duration_min: 3 * DAY, title: '出差' }),
    timed('expo', '2026-11-29', '09:00', SEOUL, 3 * DAY, { title: '展会' }),
  ];

  it('全天 3 天：11-18～20 三格都有，21 没有；跨月的（11-29 起 3 天）12 月格子里的 12-01 也有', () => {
    const cells = buildMonth({ y: 2026, m: 11 }, { events, todos: [] }, { tz: SEOUL, today: '2026-11-17', weekStart: 1, maxMarks: 4 });
    const has = (d: string, id: string) => cells.find((c) => c.date === d)?.marks.some((m) => m.itemId === id) ?? false;
    expect(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].map((d) => has(d, 'trip'))).toEqual([false, true, true, true, false]);
    const dec = buildMonth({ y: 2026, m: 12 }, { events, todos: [] }, { tz: SEOUL, today: '2026-11-17', weekStart: 1, maxMarks: 4 });
    expect(['2026-11-30', '2026-12-01', '2026-12-02'].map((d) => dec.find((c) => c.date === d)?.marks.some((m) => m.itemId === 'expo') ?? false)).toEqual([true, true, true]);
  });

  it('前一个月开始、最长 31 天的也能进来（预筛往前看 31 天）', () => {
    const long = ev({ id: 'long', date: '2026-10-20', duration_min: 31 * DAY });
    expect(dayEntries('2026-11-19', { events: [long], todos: [] }, SEOUL).map((e) => e.span?.cont)).toEqual(['start']);
    expect(dayEntries('2026-11-20', { events: [long], todos: [] }, SEOUL)).toEqual([]);
  });

  it('dayEntries 带 span：哪一段、开始和最后一天', () => {
    expect(dayEntries('2026-11-19', { events, todos: [] }, SEOUL).map((e) => [e.itemId, e.span])).toEqual([
      ['trip', { cont: 'both', date: '2026-11-18', lastDate: '2026-11-20' }],
    ]);
  });

  it('有时刻的跨天日程按设备时区换算：首尔 11-18 00:30 起 1 天，在上海是 11-17 23:30 到 11-18 23:30', () => {
    const e = timed('x', '2026-11-18', '00:30', SEOUL, DAY);
    expect(dayEntries('2026-11-17', { events: [e], todos: [] }, SH).map((d) => d.span?.cont)).toEqual(['end']);
    expect(dayEntries('2026-11-18', { events: [e], todos: [] }, SH).map((d) => d.span?.cont)).toEqual(['start']);
    expect(dayEntries('2026-11-19', { events: [e], todos: [] }, SH)).toEqual([]);
  });
});

describe('周视图：全天行每天一条、时间块按天切段', () => {
  const WEEK = '2026-11-16'; // 周一

  it('全天 3 天：周三到周五各一条，dayOf 写第几天、共几天', () => {
    const days = buildWeek(WEEK, { events: [ev({ id: 'trip', date: '2026-11-18', duration_min: 3 * DAY })], todos: [] }, { layout: 'desk', tz: SEOUL });
    expect(days.map((d) => d.allDay.dayOf)).toEqual([[], [], [{ index: 1, days: 3 }], [{ index: 2, days: 3 }], [{ index: 3, days: 3 }], [], []]);
  });

  it('有时刻 09:00 起 2 天 9 小时：三段 09:00–24:00、整天、00:00–18:00，cont 为 end、both、start', () => {
    const days = buildWeek(WEEK, { events: [timed('a', '2026-11-18', '09:00', SEOUL, 2 * DAY + 9 * 60)], todos: [] }, { layout: 'desk', tz: SEOUL });
    expect(days.flatMap((d) => d.blocks.map((b) => [d.date, b.startMin, b.endMin, b.cont]))).toEqual([
      ['2026-11-18', 540, DAY, 'end'],
      ['2026-11-19', 0, DAY, 'both'],
      ['2026-11-20', 0, 1080, 'start'],
    ]);
  });

  it('上周开始、跨进这一周的段也算；手机布局整天那段占满一行', () => {
    const days = buildWeek(WEEK, { events: [timed('b', '2026-11-10', '12:00', SEOUL, 7 * DAY)], todos: [] }, { layout: 'phone', tz: SEOUL, minBlockPx: 28, dayPx: 1440 });
    expect(days.flatMap((d) => d.blocks.map((b) => [d.date, b.startPx, b.widthPx, b.cont]))).toEqual([
      ['2026-11-16', 0, 1440, 'both'],
      ['2026-11-17', 0, 720, 'start'],
    ]);
  });
});
