// 周视图时间轴（B2 FA-3 设计审查 M1；负责人 11-04“按当周事项自动伸缩”）：默认 8～22 点，更早、更晚的事扩到那个整点
import { describe, expect, it } from 'vitest';
import { AXIS_END, AXIS_START, axisFrac, axisTicks, phoneScale, weekHourRange, weekTitle } from '../ui/week-axis.ts';

describe('weekHourRange', () => {
  it('没有事、事都在 8～22 点之内：默认 8～22', () => {
    expect(weekHourRange([])).toEqual({ h0: AXIS_START, h1: AXIS_END });
    expect(weekHourRange([[9 * 60, 10 * 60], [8 * 60, 22 * 60]])).toEqual({ h0: 8, h1: 22 });
  });

  it('更早开始的向下取整、更晚结束的向上取整', () => {
    expect(weekHourRange([[6 * 60 + 30, 7 * 60]])).toEqual({ h0: 6, h1: 22 });
    expect(weekHourRange([[7 * 60, 8 * 60]])).toEqual({ h0: 7, h1: 22 });
    expect(weekHourRange([[21 * 60, 22 * 60 + 1]])).toEqual({ h0: 8, h1: 23 });
    expect(weekHourRange([[5 * 60 + 59, 6 * 60], [23 * 60, 23 * 60 + 30]])).toEqual({ h0: 5, h1: 24 });
  });

  it('跨午夜切开的段：0:00 起的让起点到 0，到 24:00 的让终点到 24；不越出 0～24', () => {
    expect(weekHourRange([[0, 60], [23 * 60 + 30, 1440]])).toEqual({ h0: 0, h1: 24 });
    expect(weekHourRange([[-30, 2000]])).toEqual({ h0: 0, h1: 24 });
  });

  it('待办截止时刻当成一个点：22:30 截止扩到 23', () => {
    expect(weekHourRange([[22 * 60 + 30, 22 * 60 + 30]])).toEqual({ h0: 8, h1: 23 });
  });
});

describe('刻度和位置', () => {
  it('每 2 小时一条，从起点往后取偶数整点，终点也标', () => {
    expect(axisTicks({ h0: 8, h1: 22 })).toEqual([8, 10, 12, 14, 16, 18, 20, 22]);
    // 设计复审 N4：轴扩到 7 点时第一个数字是 7
    expect(axisTicks({ h0: 7, h1: 23 })).toEqual([7, 9, 11, 13, 15, 17, 19, 21, 23]);
    expect(axisTicks({ h0: 7, h1: 22 })).toEqual([7, 9, 11, 13, 15, 17, 19, 21, 22]);
    expect(axisTicks({ h0: 0, h1: 24 })).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });

  it('axisFrac：起点 0、终点 1，范围外夹住', () => {
    const r = { h0: 8, h1: 22 };
    expect(axisFrac(8 * 60, r)).toBe(0);
    expect(axisFrac(15 * 60, r)).toBe(0.5);
    expect(axisFrac(22 * 60, r)).toBe(1);
    expect(axisFrac(3 * 60, r)).toBe(0);
    expect(axisFrac(23 * 60, r)).toBe(1);
  });

  it('phoneScale：整天宽按显示的小时数放大，左移掉起点之前那段', () => {
    expect(phoneScale(336, { h0: 8, h1: 22 })).toEqual({ dayPx: 576, shiftPx: 192 });
    expect(phoneScale(240, { h0: 0, h1: 24 })).toEqual({ dayPx: 240, shiftPx: 0 });
  });
});

describe('weekTitle', () => {
  it('同月、跨月、跨年', () => {
    expect(weekTitle('2026-10-19')).toEqual({ kind: 'same', m1: 10, d1: 19, d2: 25 });
    expect(weekTitle('2026-10-26')).toEqual({ kind: 'month', m1: 10, d1: 26, m2: 11, d2: 1 });
    expect(weekTitle('2026-12-28')).toEqual({ kind: 'year', y1: 2026, m1: 12, d1: 28, y2: 2027, m2: 1, d2: 3 });
  });
});
