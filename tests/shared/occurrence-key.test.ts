// “同一次提醒”的标识 occurrenceKey（shared/logic/remind-route.ts）和全天日程提醒落在哪天 allDayRemindDay（shared/logic/remind.ts）。
// REMIND-close-occkey（11-04）：两个函数从 src/features/reminders/data/reminder-model.ts 挪进 shared，推送负载由服务器调同一份。
// remind-route.ts 不准 import（SW 要引），判“是不是全天日程提醒”的条件（isAllDayRemind）只好和 allDayRemindDay 各写一份——
// 这里拿同一批边界行逐个核对两边判得一样，免得以后各改各的（协调方 11-04 要求）。
// Node（vitest）和 Deno（deno task test）各跑一遍：只用 toBe、toEqual
import { describe, expect, it } from 'vitest';
import { allDayRemindDay } from '../../shared/logic/remind.ts';
import { isAllDayRemind, occurrenceKey, reminderTag, type ReminderKind } from '../../shared/logic/remind-route.ts';

const ID = '0b9f3c2e-1111-4222-8333-444455556666';
const DUE = 1_793_000_000_000;

/** 边界行：time（null、没有这一列、空串、'09:00'、非字符串）× date（字符串、null、数字）× remind_days（0、1、2、-1、null、'1'、0.5、NaN、没有这一列） */
function rows(): Readonly<Record<string, unknown>>[] {
  const times: unknown[] = [null, undefined, '', '09:00', 900];
  const dates: unknown[] = ['2026-11-05', null, 20261105];
  const days: unknown[] = [0, 1, 2, -1, null, '1', 0.5, Number.NaN, undefined];
  const out: Record<string, unknown>[] = [];
  for (const t of times) for (const d of dates) for (const n of days) {
    const r: Record<string, unknown> = {};
    if (t !== undefined) r['time'] = t;
    if (d !== undefined) r['date'] = d;
    if (n !== undefined) r['remind_days'] = n;
    out.push(r);
  }
  return out;
}

describe('isAllDayRemind 和 allDayRemindDay 判“全天日程提醒”的条件一致', () => {
  it('每一条边界行：isAllDayRemind(row) === (allDayRemindDay(row) !== null)', () => {
    const bad: string[] = [];
    for (const r of rows()) if (isAllDayRemind(r) !== (allDayRemindDay(r) !== null)) bad.push(JSON.stringify(r));
    expect(bad).toEqual([]);
  });
  it('只有 time 不是字符串、date 是字符串、remind_days 是 0 或 1 才算（time 为空串也不算全天；remind_days 取 2 不算）', () => {
    expect(isAllDayRemind({ time: null, date: '2026-11-05', remind_days: 0 })).toBe(true);
    expect(isAllDayRemind({ date: '2026-11-05', remind_days: 1 })).toBe(true);
    expect(isAllDayRemind({ time: null, date: '2026-11-05', remind_days: 2 })).toBe(false);
    expect(isAllDayRemind({ time: '', date: '2026-11-05', remind_days: 0 })).toBe(false);
    expect(isAllDayRemind({ time: null, date: '2026-11-05', remind_days: null })).toBe(false);
    expect(isAllDayRemind({ time: null, date: '2026-11-05', remind_days: '1' })).toBe(false);
    expect(allDayRemindDay({ time: null, date: '2026-11-05', remind_days: 0 })).toBe('2026-11-05');
    expect(allDayRemindDay({ time: null, date: '2026-11-05', remind_days: 1 })).toBe('2026-11-04');
    expect(allDayRemindDay({ time: null, date: '2026-03-01', remind_days: 1 })).toBe('2026-02-28');
  });
});

describe('occurrenceKey 的口径（R-336；前端横幅、本机通知、推送负载同一份）', () => {
  const ref = (kind: ReminderKind, row: Readonly<Record<string, unknown>>, snoozed = false) =>
    ({ kind, id: ID, tag: reminderTag(kind, ID, DUE), snoozed, row });
  it('全天日程（没按稍后）：event:<id>:allday:<日期>:<remind_days>，不看时刻', () => {
    expect(occurrenceKey(ref('event', { time: null, date: '2026-11-05', remind_days: 0 }))).toBe(`event:${ID}:allday:2026-11-05:0`);
    expect(occurrenceKey(ref('event', { time: null, date: '2026-11-06', remind_days: 1 }))).toBe(`event:${ID}:allday:2026-11-06:1`);
  });
  it('有时刻的日程、待办、按了稍后的全天日程、remind_days 不合法的全天日程：就是 tag', () => {
    expect(occurrenceKey(ref('event', { time: '10:00', date: '2026-11-05', remind_days: null }))).toBe(`event:${ID}:${DUE}`);
    expect(occurrenceKey(ref('todo', { due: '2026-11-05', remind_days: 0 }))).toBe(`todo:${ID}:${DUE}`);
    expect(occurrenceKey(ref('event', { time: null, date: '2026-11-05', remind_days: 0 }, true))).toBe(`event:${ID}:${DUE}`);
    expect(occurrenceKey(ref('event', { time: null, date: '2026-11-05', remind_days: 2 }))).toBe(`event:${ID}:${DUE}`);
  });
  it('纪念日：照 reminderTag（纪念日的 occurrenceKey 等 B5 再定）；即使行里碰巧有 date、remind_days 也不走全天写法', () => {
    expect(occurrenceKey(ref('anniv', { date: '2026-11-05', remind_days: 0 }))).toBe(`anniv:${ID}:${DUE}`);
  });
});
