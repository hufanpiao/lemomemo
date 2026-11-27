// kit 选择器的纯规则（Pick/pick-logic.ts；11-21 定稿 方案-v2 第一套）：周条（周起始跟日历设置）、范围、周箭头、分钟格。跨夜挪到 calendar 的 endsNextDay（event-edit.test.ts）
import { describe, expect, it } from 'vitest';
import {
  dayRange, DEFAULT_TIME, draftOf, HOURS, minutesOf, monthDiff, monthJump, monthOfWeek, MONTHS_AHEAD, MONTHS_BACK, monthSpan, outOfRange, weekArrows, weekOf, withHour, withMinute,
} from '../Pick/pick-logic.ts';

describe('周条', () => {
  it('一周从哪天起跟设置（评审第 1 条）：周日起时 2026-11-22（周日）那周从 11-22 起；周一起时从 11-23 起', () => {
    expect(weekOf('2026-11-22', 0)).toBe('2026-11-22');
    expect(weekOf('2026-11-25', 0)).toBe('2026-11-22');
    expect(weekOf('2026-11-21', 0)).toBe('2026-11-15');
    expect(weekOf('2026-11-22', 1)).toBe('2026-11-16');
    expect(weekOf('2026-11-25', 1)).toBe('2026-11-23');
  });

  it('日期滑条（负责人 11-23“做成跟时间一样的那种滑动”）：从第一个月 1 号那周排到最后一个月月底那周，整周、一天不漏', () => {
    const xs = dayRange(['2026-11', '2026-12'], 0);
    expect(xs[0]).toBe('2026-11-01');
    expect(xs[xs.length - 1]).toBe('2027-01-02');
    expect(xs.length % 7).toBe(0);
    expect(xs).toContain('2026-12-31');
    const ys = dayRange(['2026-11', '2026-12'], 1);
    expect(ys[0]).toBe('2026-10-26');
    expect(ys[ys.length - 1]).toBe('2027-01-03');
    expect(dayRange([], 0)).toEqual([]);
  });
});

describe('范围（日程结束：开始当天到 +30 天）', () => {
  const min = '2026-11-22';
  const max = '2026-12-22';
  it('范围外的日子灰掉，两头当天能选', () => {
    expect(outOfRange('2026-11-21', min, max)).toBe(true);
    expect(outOfRange('2026-11-22', min, max)).toBe(false);
    expect(outOfRange('2026-12-22', min, max)).toBe(false);
    expect(outOfRange('2026-12-23', min, max)).toBe(true);
    expect(outOfRange('1999-01-01')).toBe(false);
  });

  it('周箭头到边禁用：这一周碰到 min 不能往前，碰到 max 不能往后', () => {
    expect(weekArrows('2026-11-22', min, max)).toEqual({ prev: false, next: true });
    expect(weekArrows('2026-11-15', min, max)).toEqual({ prev: false, next: true });
    expect(weekArrows('2026-11-29', min, max)).toEqual({ prev: true, next: true });
    expect(weekArrows('2026-12-20', min, max)).toEqual({ prev: true, next: false });
    expect(weekArrows('2026-12-13', min, max)).toEqual({ prev: true, next: true });
    expect(weekArrows('2026-12-13')).toEqual({ prev: true, next: true });
  });
});

describe('月份列表（负责人 11-23“点周标题弹月份”）', () => {
  it('没给范围：今天、草稿、正在看的月里最早往前 12 个月，最晚往后 24 个月，跨年连续', () => {
    const xs = monthSpan('2026-11-22', '2026-11-23', '2026-11-23');
    expect(xs[0]).toBe('2025-11');
    expect(xs.at(-1)).toBe('2028-11');
    expect(xs).toHaveLength(MONTHS_BACK + MONTHS_AHEAD + 1);
    expect(xs).toContain('2027-01');
    expect(xs.indexOf('2027-01') - xs.indexOf('2026-12')).toBe(1);
  });

  it('给了范围按范围截（日程结束：开始当天到 +30 天）', () => {
    expect(monthSpan('2026-11-22', '2026-11-23', '2026-11-23', '2026-11-22', '2026-12-22')).toEqual(['2026-11', '2026-12']);
  });

  it('这一周算最后一天的月；跳月到含 1 号的那一周，早于 min 时跳到含 min 的那一周', () => {
    expect(monthOfWeek('2026-11-29')).toBe('2026-12');
    expect(monthJump('2027-02', 0)).toBe('2027-01-31');
    expect(monthOfWeek(monthJump('2027-02', 0))).toBe('2027-02');
    expect(monthJump('2027-02', 1)).toBe('2027-02-01');
    expect(monthJump('2026-11', 0, '2026-11-22')).toBe('2026-11-22');
    expect(monthDiff('2026-11', '2027-02')).toBe(3);
    expect(monthDiff('2026-11', '2026-09')).toBe(-2);
  });
});

describe('时、分', () => {
  it('时 00～23；分 5 分一格，不在格上的现值插进去、照大小排', () => {
    expect(HOURS).toHaveLength(24);
    expect(HOURS[0]).toBe('00');
    expect(HOURS[23]).toBe('23');
    expect(minutesOf('00')).toEqual(['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
    expect(minutesOf('07')).toEqual(['00', '05', '07', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
    expect(minutesOf(undefined)).toHaveLength(12);
    expect(minutesOf('xx')).toHaveLength(12);
  });

  it('换时不动分、换分不动时', () => {
    expect(withHour('09:07', '15')).toBe('15:07');
    expect(withMinute('09:07', '30')).toBe('09:30');
  });

  it('打开时的草稿：没值的日期用今天、时刻用 9:00（清空过的截止日再打开）', () => {
    expect(draftOf(null, null, '2026-11-21')).toEqual({ date: '2026-11-21', time: DEFAULT_TIME });
    expect(draftOf('2026-11-22', '15:00', '2026-11-21')).toEqual({ date: '2026-11-22', time: '15:00' });
  });
});
