// shared/core/date.ts、tz.ts（架构 2.1、4.6）：结果只取决于传进来的 tz，和运行环境的时区无关
// test:tz 会在 UTC、Asia/Seoul、America/Los_Angeles 三个进程时区各跑一遍；Deno 也跑同一份
import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  hourOf,
  minOfDay,
  msAt,
  parseDate,
  parseHm,
  todayOf,
  weekdayOf,
} from '../../shared/core/date.ts';
import { isValidTz, offsetMin, wallTime } from '../../shared/core/tz.ts';

const SEOUL = 'Asia/Seoul';
const SHANGHAI = 'Asia/Shanghai';
const LA = 'America/Los_Angeles';

describe('tz', () => {
  it('isValidTz', () => {
    expect(isValidTz(SEOUL)).toBe(true);
    expect(isValidTz('UTC')).toBe(true);
    expect(isValidTz('Mars/Base')).toBe(false);
    expect(isValidTz('')).toBe(false);
  });

  it('offsetMin：首尔 +540，上海 +480，洛杉矶夏令时 -420、冬令时 -480', () => {
    const summer = Date.UTC(2026, 6, 1, 12);
    const winter = Date.UTC(2026, 0, 15, 12);
    expect(offsetMin(summer, SEOUL)).toBe(540);
    expect(offsetMin(summer, SHANGHAI)).toBe(480);
    expect(offsetMin(summer, LA)).toBe(-420);
    expect(offsetMin(winter, LA)).toBe(-480);
  });

  it('wallTime：午夜是 0 点（h23），不是 24 点', () => {
    expect(wallTime(Date.UTC(2026, 9, 27, 15, 0), SEOUL)).toEqual({ y: 2026, m: 10, d: 28, hh: 0, mm: 0, ss: 0 });
  });
});

describe('msAt / todayOf / minOfDay / hourOf', () => {
  it('首尔 10-28 09:00 = UTC 00:00', () => {
    expect(msAt('2026-10-28', 540, SEOUL)).toBe(Date.UTC(2026, 9, 28, 0, 0));
  });

  it('同一时刻在不同时区是不同的一天', () => {
    const ms = Date.UTC(2026, 9, 27, 15, 30); // 首尔 10-28 00:30，洛杉矶 10-27 08:30
    expect(todayOf(ms, SEOUL)).toBe('2026-10-28');
    expect(todayOf(ms, LA)).toBe('2026-10-27');
    expect(minOfDay(ms, SEOUL)).toBe(30);
    expect(hourOf(ms, LA)).toBe(8);
  });

  it('夏令时拨快：跳过的 02:30 按拨快后的 03:30 算', () => {
    // 2026-03-08 洛杉矶 02:00 → 03:00；03:30 PDT = UTC 10:30
    expect(msAt('2026-03-08', 150, LA)).toBe(Date.UTC(2026, 2, 8, 10, 30));
  });

  it('夏令时拨慢：重复的 01:30 取先出现的一次（PDT）', () => {
    // 2026-11-01 洛杉矶 02:00 → 01:00；先出现的 01:30 PDT = UTC 08:30
    expect(msAt('2026-11-01', 90, LA)).toBe(Date.UTC(2026, 10, 1, 8, 30));
  });

  it('来回换算：每个时区、每个整点都能还原（夏令时跳过的那一小时除外）', () => {
    for (const tz of [SEOUL, SHANGHAI, LA, 'UTC', 'Europe/London']) {
      for (const d of ['2026-01-01', '2026-03-08', '2026-03-29', '2026-07-15', '2026-10-25', '2026-11-01', '2028-02-29']) {
        for (let min = 0; min < 1440; min += 60) {
          const ms = msAt(d, min, tz);
          const back = minOfDay(ms, tz);
          if (back !== min) {
            // 只有拨快那天被跳过的时段允许不同，且一定是往后挪
            expect(back, `${tz} ${d} ${min}`).toBeGreaterThan(min);
            continue;
          }
          expect(todayOf(ms, tz), `${tz} ${d} ${min}`).toBe(d);
        }
      }
    }
  });

  it('分钟数越界、日期不存在都抛错', () => {
    expect(() => msAt('2026-10-28', 1440, SEOUL)).toThrow('bad_min');
    expect(() => msAt('2026-10-28', -1, SEOUL)).toThrow('bad_min');
    expect(() => msAt('2026-02-30', 0, SEOUL)).toThrow('bad_date');
  });
});

describe('纯日期运算', () => {
  it('parseDate', () => {
    expect(parseDate('2026-10-28')).toEqual({ y: 2026, m: 10, d: 28 });
    expect(() => parseDate('2026-2-3')).toThrow('bad_date');
    expect(() => parseDate('2027-02-29')).toThrow('bad_date');
  });

  it('addDays：跨月、跨年、闰年、负数', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // 夏令时那天也是整天
  });

  it('weekdayOf：0 = 周日', () => {
    expect(weekdayOf('2026-10-25')).toBe(0);
    expect(weekdayOf('2026-10-28')).toBe(3);
  });

  it('diffDays', () => {
    expect(diffDays('2026-10-28', '2026-11-04')).toBe(7);
    expect(diffDays('2026-11-04', '2026-10-28')).toBe(-7);
    expect(diffDays('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('parseHm', () => {
    expect(parseHm('00:00')).toBe(0);
    expect(parseHm('23:59')).toBe(1439);
    expect(() => parseHm('24:00')).toThrow('bad_time');
    expect(() => parseHm('9:00')).toThrow('bad_time');
  });
});
