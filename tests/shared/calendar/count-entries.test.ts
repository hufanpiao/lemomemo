// 日历顶部“本月 N 项”“本周 N 项”的计数（负责人 11-18 选年月标题甲方案）：跨天日程只算一件，口径同 collectEntries
import { describe, expect, it } from 'vitest';
import { collectEntries, countEntries, dayEntries } from '../../../shared/logic/calendar/cal-items.ts';
import { buildWeek } from '../../../shared/logic/calendar/week-view.ts';
import { ev, timed, todo } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const DAY = 24 * 60;

describe('countEntries', () => {
  it('跨三天的全天日程只算一件；范围外的、已完成的待办不算', () => {
    const items = {
      events: [ev({ id: 'trip', date: '2026-11-10', duration_min: 3 * DAY }), timed('mtg', '2026-11-12', '10:00', SEOUL), timed('out', '2026-12-01', '10:00', SEOUL)],
      todos: [todo({ id: 'a', due: '2026-11-20' }), todo({ id: 'b', due: '2026-11-21', done: true })],
    };
    expect(countEntries(items, '2026-11-01', '2026-11-30', SEOUL)).toBe(3);
  });

  it('没有事项是 0；时区不对直接报错', () => {
    expect(countEntries({ events: [], todos: [] }, '2026-11-01', '2026-11-30', SEOUL)).toBe(0);
    expect(() => countEntries({ events: [], todos: [] }, '2026-11-01', '2026-11-30', 'Nope/Zone')).toThrow();
  });

  it('已完成的待办只在周历留着（keepDone，条目带 done）；月历、单日列表、“本周 N 项”照旧不算（负责人 11-21）', () => {
    const items = { events: [], todos: [todo({ id: 'a', due: '2026-11-04', done: true }), todo({ id: 'b', due: '2026-11-04' }), todo({ id: 'c', due: '2026-11-04', done: true, deleted_at: 1 })] };
    const ids = (m: Map<string, readonly { itemId: string }[]>): string[] => (m.get('2026-11-04') ?? []).map((e) => e.itemId);
    expect(ids(collectEntries(items, '2026-11-02', '2026-11-08', SEOUL))).toEqual(['b']);
    const kept = collectEntries(items, '2026-11-02', '2026-11-08', SEOUL, { keepDone: true }).get('2026-11-04') ?? [];
    expect(kept.map((e) => [e.itemId, e.done ?? false]).sort()).toEqual([['a', true], ['b', false]]);
    expect(dayEntries('2026-11-04', items, SEOUL).map((e) => e.itemId)).toEqual(['b']);
    expect(countEntries(items, '2026-11-02', '2026-11-08', SEOUL)).toBe(1);
    const week = buildWeek('2026-11-02', items, { layout: 'phone', tz: SEOUL, minBlockPx: 28, dayPx: 300 });
    expect(week[2]?.todos.map((x) => x.entry.itemId).sort()).toEqual(['a', 'b']);
  });
});
