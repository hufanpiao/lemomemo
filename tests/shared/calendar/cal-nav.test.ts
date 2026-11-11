// shared/logic/calendar/cal-nav.ts（TC-B2-13；架构 5.12 第 3 点、R-99、R-101、第 9 节单元“日历路由”）
import { describe, expect, it } from 'vitest';
import {
  isThisMonth,
  isThisWeek,
  lastOfMonth,
  monthKey,
  parseMonthKey,
  parseWeekParam,
  resolveMonthParam,
  resolveWeekParam,
  resolveWeekStart,
  shiftMonth,
  shiftWeek,
  startOfWeek,
  weekDates,
  weekInRange,
  weekOfPickedMonth,
} from '../../../shared/logic/calendar/cal-nav.ts';

describe('周起始日', () => {
  it('设置了 0–6 就按设置，没设或不认识按界面语言（中文周一、韩文周日）', () => {
    expect(resolveWeekStart(0, 'zh-CN')).toBe(0);
    expect(resolveWeekStart(1, 'ko-KR')).toBe(1);
    // 只认 0、1：2–6 回落到默认（代码审查 11-04）
    expect(resolveWeekStart(6, 'zh-CN')).toBe(1);
    expect(resolveWeekStart(2, 'ko-KR')).toBe(0);
    expect(resolveWeekStart(5, 'zh-CN')).toBe(1);
    expect(resolveWeekStart(undefined, 'zh-CN')).toBe(1);
    expect(resolveWeekStart(null, 'ko-KR')).toBe(0);
    expect(resolveWeekStart(7, 'zh-CN')).toBe(1);
    expect(resolveWeekStart('1', 'ko-KR')).toBe(0);
    expect(resolveWeekStart(1.5, 'ko-KR')).toBe(0);
  });

  it('startOfWeek：2026-11-04（周三）周一起始 → 11-02，周日起始 → 11-01，周六起始 → 10-31', () => {
    expect(startOfWeek('2026-11-04', 1)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-04', 0)).toBe('2026-11-01');
    expect(startOfWeek('2026-11-04', 6)).toBe('2026-10-31');
  });

  it('当天就是周起始日时不动', () => {
    expect(startOfWeek('2026-11-01', 0)).toBe('2026-11-01');
    expect(startOfWeek('2026-11-02', 1)).toBe('2026-11-02');
  });

  it('weekDates：跨月、跨年连续 7 天', () => {
    expect(weekDates('2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });
});

describe('翻月、翻周', () => {
  it('上一月 / 下一月跨年', () => {
    expect(shiftMonth({ y: 2026, m: 12 }, 1)).toEqual({ y: 2027, m: 1 });
    expect(shiftMonth({ y: 2027, m: 1 }, -1)).toEqual({ y: 2026, m: 12 });
    expect(shiftMonth({ y: 2026, m: 10 }, 0)).toEqual({ y: 2026, m: 10 });
    expect(shiftMonth({ y: 2026, m: 3 }, -15)).toEqual({ y: 2024, m: 12 });
    expect(shiftMonth({ y: 2026, m: 3 }, 25)).toEqual({ y: 2028, m: 4 });
  });

  it('某月最后一天：大小月、闰年 2 月、12 月', () => {
    expect(lastOfMonth({ y: 2026, m: 11 })).toBe('2026-11-30');
    expect(lastOfMonth({ y: 2026, m: 12 })).toBe('2026-12-31');
    expect(lastOfMonth({ y: 2028, m: 2 })).toBe('2028-02-29');
    expect(lastOfMonth({ y: 2026, m: 2 })).toBe('2026-02-28');
    expect(() => lastOfMonth({ y: 2026, m: 13 })).toThrow('bad_month');
  });

  it('月份不合法时抛错', () => {
    expect(() => shiftMonth({ y: 2026, m: 13 }, 1)).toThrow('bad_month');
    expect(() => shiftMonth({ y: 2026, m: 0 }, 1)).toThrow('bad_month');
  });

  it('上一周 / 下一周跨月、跨年', () => {
    expect(shiftWeek('2026-10-26', 1)).toBe('2026-11-02');
    expect(shiftWeek('2026-12-28', 1)).toBe('2027-01-04');
    expect(shiftWeek('2027-01-04', -1)).toBe('2026-12-28');
  });

  it('闰年 2 月：2028-02-28 那周之后是 02-29 所在的', () => {
    expect(weekDates('2028-02-27')).toContain('2028-02-29');
    expect(shiftWeek('2028-02-27', 1)).toBe('2028-03-05');
  });
});

describe('路由参数（#/cal/month/…、#/cal/week/…）', () => {
  const today = '2026-11-04';

  it('月：合法参数原样，不带参数和非法参数回到本月', () => {
    expect(resolveMonthParam('2026-10', today)).toEqual({ y: 2026, m: 10 });
    expect(resolveMonthParam(undefined, today)).toEqual({ y: 2026, m: 11 });
    expect(resolveMonthParam('', today)).toEqual({ y: 2026, m: 11 });
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', 'abcd-ef', '1899-12', '2101-01']) {
      expect(resolveMonthParam(bad, today), bad).toEqual({ y: 2026, m: 11 });
    }
  });

  it('monthKey 和 parseMonthKey 互逆', () => {
    expect(monthKey({ y: 2026, m: 3 })).toBe('2026-03');
    expect(parseMonthKey('2026-03')).toEqual({ y: 2026, m: 3 });
    expect(parseMonthKey('2026-3')).toBeNull();
  });

  it('周：任意一天按周起始日规整到那周第一天', () => {
    expect(resolveWeekParam('2026-10-19', today, 1)).toBe('2026-10-19');
    expect(resolveWeekParam('2026-10-21', today, 1)).toBe('2026-10-19');
    expect(resolveWeekParam('2026-10-21', today, 0)).toBe('2026-10-18');
  });

  it('周：不带参数、非法日期、不存在的日期回到本周', () => {
    expect(resolveWeekParam(undefined, today, 1)).toBe('2026-11-02');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', 'x', '1899-12-24', '2101-01-08']) {
      expect(resolveWeekParam(bad, today, 1), bad).toBe('2026-11-02');
      expect(resolveWeekParam(bad, today, 0), bad).toBe('2026-11-01');
    }
  });

  // 代码审查 FA-3 L2：年份按“这一周有没有一天在 1900–2100 里”判断，1900 年第一周、2100 年最后一周都到得了
  it('周：1900 年第一周（周日起始那周从 1899-12-31 开始）合法，不回到本周', () => {
    // 1900-01-01 是周一：周日起始那周 1899-12-31～1900-01-06
    expect(resolveWeekParam('1899-12-31', today, 0)).toBe('1899-12-31');
    expect(resolveWeekParam('1900-01-01', today, 0)).toBe('1899-12-31');
    expect(resolveWeekParam('1900-01-06', today, 0)).toBe('1899-12-31');
    // 周一起始时 1899-12-31 那周（1899-12-25～31）一天都不在范围里
    expect(resolveWeekParam('1899-12-31', today, 1)).toBe('2026-11-02');
    expect(resolveWeekParam('1900-01-01', today, 1)).toBe('1900-01-01');
    // 周六起始：1899-12-30～1900-01-05
    expect(resolveWeekParam('1900-01-03', today, 6)).toBe('1899-12-30');
  });

  it('周：2100 年最后一周跨进 2101 年也合法（2100-12-31 是周五）', () => {
    expect(resolveWeekParam('2100-12-31', today, 0)).toBe('2100-12-26');
    expect(resolveWeekParam('2101-01-01', today, 0)).toBe('2100-12-26');
    expect(resolveWeekParam('2101-01-02', today, 0)).toBe('2026-11-01');
  });

  it('parseWeekParam：合法时给那周第一天，没参数 / 非法 / 整周超范围给 null（调用方据此决定要不要 replace）', () => {
    expect(parseWeekParam('2026-11-01', 1)).toBe('2026-10-26');
    expect(parseWeekParam('2026-11-01', 0)).toBe('2026-11-01');
    expect(parseWeekParam('1899-12-31', 0)).toBe('1899-12-31');
    expect(parseWeekParam(undefined, 0)).toBeNull();
    expect(parseWeekParam('', 0)).toBeNull();
    expect(parseWeekParam('2026-02-30', 0)).toBeNull();
    expect(parseWeekParam('1899-12-31', 1)).toBeNull();
  });

  it('parseWeekParam 边界（代码审查 11-04）：周一起始 2101-01-02 还在 2100 年最后一周，2101-01-03 起整周超范围；离谱年份给 null', () => {
    expect(parseWeekParam('2101-01-02', 1)).toBe('2100-12-27');
    expect(parseWeekParam('2101-01-03', 1)).toBeNull();
    expect(parseWeekParam('0050-03-01', 1)).toBeNull();
    expect(parseWeekParam('0000-01-01', 0)).toBeNull();
    expect(parseWeekParam('9999-12-31', 1)).toBeNull();
  });

  // 代码审查 FA-3 L4：周起始从默认值（设置还没同步）换成用户设的值时，要从地址里原来那一天重新算，
  // 而不是从按旧周起始规整过的日期再规整一次
  it('周起始变了：从原始那天重新规整得到正确的周；从旧规整结果再规整会差一周', () => {
    const fromPush = '2026-11-01'; // 周日，推送 / 搜索带来的
    const byDefault = resolveWeekParam(fromPush, today, 1); // 中文默认周一起始
    expect(byDefault).toBe('2026-10-26');
    expect(resolveWeekParam(fromPush, today, 0)).toBe('2026-11-01'); // 对：原始那天重新规整
    expect(resolveWeekParam(byDefault, today, 0)).toBe('2026-10-25'); // 错：差了一周，所以合法参数不能被 replace 掉
  });

  it('weekInRange：从 start 起的 7 天里有一天在 1900–2100 就算在范围内', () => {
    expect(weekInRange('1899-12-31')).toBe(true);
    expect(weekInRange('1899-12-26')).toBe(true);
    expect(weekInRange('1899-12-25')).toBe(false);
    expect(weekInRange('2100-12-31')).toBe(true);
    expect(weekInRange('2101-01-01')).toBe(false);
    expect(weekInRange('2026-11-02')).toBe(true);
  });

  it('周：闰日 2028-02-29 合法，2027-02-29 不合法', () => {
    expect(resolveWeekParam('2028-02-29', today, 1)).toBe('2028-02-28');
    expect(resolveWeekParam('2027-02-29', today, 1)).toBe('2026-11-02');
  });
});

describe('年月选择器在周视图（R-101）', () => {
  it('2026-11 周一起始 → 2026-10-26；周日起始 → 2026-11-01', () => {
    expect(weekOfPickedMonth({ y: 2026, m: 11 }, 1)).toBe('2026-10-26');
    expect(weekOfPickedMonth({ y: 2026, m: 11 }, 0)).toBe('2026-11-01');
  });
  it('跨年：2027-01（1 日是周五）周一起始 → 2026-12-28', () => {
    expect(weekOfPickedMonth({ y: 2027, m: 1 }, 1)).toBe('2026-12-28');
  });
  it('1900-01 周日起始 → 1899-12-31，这个参数再解析回来仍是这一周（代码审查 L2）', () => {
    const start = weekOfPickedMonth({ y: 1900, m: 1 }, 0);
    expect(start).toBe('1899-12-31');
    expect(resolveWeekParam(start, '2026-11-04', 0)).toBe(start);
    expect(weekInRange(start)).toBe(true);
  });
});

describe('“今天”按钮灰不灰', () => {
  it('本月 / 别的月', () => {
    expect(isThisMonth({ y: 2026, m: 11 }, '2026-11-30')).toBe(true);
    expect(isThisMonth({ y: 2026, m: 12 }, '2026-11-30')).toBe(false);
    expect(isThisMonth({ y: 2025, m: 11 }, '2026-11-30')).toBe(false);
  });
  it('本周 / 别的周（跟周起始日）', () => {
    expect(isThisWeek('2026-11-02', '2026-11-08', 1)).toBe(true);
    expect(isThisWeek('2026-11-02', '2026-11-09', 1)).toBe(false);
    expect(isThisWeek('2026-11-08', '2026-11-08', 0)).toBe(true);
  });
});
