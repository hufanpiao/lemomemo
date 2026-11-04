// 月历、周视图的路由和翻页（B2 FA-3，架构 5.12；TC-B2-13～16 的页面一侧）
import { describe, expect, it } from 'vitest';
import { headerMonth, isCurrent, paramsOf, pickMonth, resolveView, shiftView, switchMode, todayView } from '../data/cal-route.ts';

const TODAY = '2026-11-05'; // 周四

describe('resolveView：地址参数 → 视图', () => {
  it('#/calendar（没有参数）：本月，不改地址', () => {
    expect(resolveView([], TODAY, 1)).toEqual({ view: { mode: 'month', ym: { y: 2026, m: 11 } }, canonical: null });
  });

  it('月参数合法：照用；非法、超出 1900～2100：回到本月并给出规整的参数', () => {
    expect(resolveView(['month', '2027-02'], TODAY, 1)).toEqual({ view: { mode: 'month', ym: { y: 2027, m: 2 } }, canonical: null });
    for (const bad of ['2026-13', 'x', '1899-12', '2101-01']) {
      expect(resolveView(['month', bad], TODAY, 1)).toEqual({ view: { mode: 'month', ym: { y: 2026, m: 11 } }, canonical: ['month', '2026-11'] });
    }
    expect(resolveView(['month'], TODAY, 1).canonical).toEqual(['month', '2026-11']);
  });

  it('周参数：任一天落到那周（周一起始 / 周日起始）；合法时不改地址（L4）', () => {
    expect(resolveView(['week', '2026-11-02'], TODAY, 1)).toEqual({ view: { mode: 'week', start: '2026-11-02' }, canonical: null });
    expect(resolveView(['week', '2026-11-05'], TODAY, 1)).toEqual({ view: { mode: 'week', start: '2026-11-02' }, canonical: null });
    expect(resolveView(['week', '2026-11-05'], TODAY, 0).view).toEqual({ mode: 'week', start: '2026-11-01' });
    expect(resolveView(['week', '2026-02-30'], TODAY, 1).view).toEqual({ mode: 'week', start: '2026-11-02' });
  });

  it('周参数带多余的段：replace 成 [week, 那一天]（代码审查 11-04）', () => {
    expect(resolveView(['week', '2026-11-05', 'x'], TODAY, 1)).toEqual({ view: { mode: 'week', start: '2026-11-02' }, canonical: ['week', '2026-11-05'] });
  });

  it('认不出的模式当月视图', () => {
    expect(resolveView(['day', '2026-11-05'], TODAY, 1).view).toEqual({ mode: 'month', ym: { y: 2026, m: 11 } });
  });
});

describe('翻页、今天、切换、选年月', () => {
  it('上一页 / 下一页：月跨年、周跨月；超出 1900～2100 不翻', () => {
    expect(shiftView({ mode: 'month', ym: { y: 2026, m: 12 } }, 1)).toEqual({ mode: 'month', ym: { y: 2027, m: 1 } });
    expect(shiftView({ mode: 'week', start: '2026-10-26' }, 1)).toEqual({ mode: 'week', start: '2026-11-02' });
    expect(shiftView({ mode: 'month', ym: { y: 2100, m: 12 } }, 1)).toBeNull();
    expect(shiftView({ mode: 'month', ym: { y: 1900, m: 1 } }, -1)).toBeNull();
  });

  it('今天：同一种视图的本月 / 本周；在本月、本周时 isCurrent', () => {
    expect(todayView('week', TODAY, 1)).toEqual({ mode: 'week', start: '2026-11-02' });
    expect(isCurrent(todayView('month', TODAY, 1), TODAY, 1)).toBe(true);
    expect(isCurrent({ mode: 'week', start: '2026-10-26' }, TODAY, 1)).toBe(false);
  });

  it('月 → 周：本月取本周，别的月取 1 日那周；周 → 月：取多数天数所在的月', () => {
    expect(switchMode({ mode: 'month', ym: { y: 2026, m: 11 } }, TODAY, 1)).toEqual({ mode: 'week', start: '2026-11-02' });
    expect(switchMode({ mode: 'month', ym: { y: 2027, m: 1 } }, TODAY, 1)).toEqual({ mode: 'week', start: '2026-12-28' });
    // 2026-10-26～11-01：10 月占 6 天
    expect(switchMode({ mode: 'week', start: '2026-10-26' }, TODAY, 1)).toEqual({ mode: 'month', ym: { y: 2026, m: 10 } });
    // 2026-12-28～2027-01-03：12 月占 4 天
    expect(headerMonth({ mode: 'week', start: '2026-12-28' })).toEqual({ y: 2026, m: 12 });
    expect(headerMonth({ mode: 'week', start: '2026-12-29' })).toEqual({ y: 2027, m: 1 });
  });

  it('选年月：月视图跳到那月；周视图跳到那月 1 日所在的周（R-101）', () => {
    expect(pickMonth({ mode: 'month', ym: { y: 2026, m: 11 } }, { y: 2030, m: 5 }, 1)).toEqual({ mode: 'month', ym: { y: 2030, m: 5 } });
    expect(pickMonth({ mode: 'week', start: '2026-11-02' }, { y: 2026, m: 11 }, 1)).toEqual({ mode: 'week', start: '2026-10-26' });
    expect(pickMonth({ mode: 'week', start: '2026-11-02' }, { y: 2026, m: 11 }, 0)).toEqual({ mode: 'week', start: '2026-11-01' });
  });

  it('paramsOf 和 resolveView 互为往返', () => {
    const views = [
      { mode: 'month', ym: { y: 2026, m: 3 } },
      { mode: 'week', start: '2026-11-02' },
    ] as const;
    for (const v of views) expect(resolveView(paramsOf(v), TODAY, 1)).toEqual({ view: v, canonical: null });
  });
});

const T = '2026-11-04';
describe('L2、L4（前端 B 改 cal-nav 后配合，11-04）', () => {
  it('L4：推送带来周日，先按默认周一起始再按周日起始，落到对的那周且不改地址', () => {
    const a = resolveView(['week', '2026-11-01'], T, 1);
    expect(a).toEqual({ view: { mode: 'week', start: '2026-10-26' }, canonical: null });
    const b = resolveView(['week', '2026-11-01'], T, 0);
    expect(b).toEqual({ view: { mode: 'week', start: '2026-11-01' }, canonical: null });
  });
  it('L4：非法参数 replace 成今天（锚点），今天是周日时设置晚到也落在本周', () => {
    const sun = '2026-11-08';
    const a = resolveView(['week'], sun, 1);
    expect(a.canonical).toEqual(['week', sun]);
    expect(resolveView(a.canonical ?? [], sun, 0).view).toEqual({ mode: 'week', start: sun });
  });
  it('L2：周日起始选 1900-01 → 1899-12-31，解析回来不变；从下一周翻回来也翻得动', () => {
    const v = pickMonth({ mode: 'week', start: '2026-11-01' }, { y: 1900, m: 1 }, 0);
    expect(v).toEqual({ mode: 'week', start: '1899-12-31' });
    expect(resolveView(paramsOf(v), T, 0)).toEqual({ view: v, canonical: null });
    expect(shiftView({ mode: 'week', start: '1900-01-07' }, -1)).toEqual(v);
    expect(shiftView(v, -1)).toBeNull();
    expect(shiftView({ mode: 'week', start: '2100-12-19' }, 1)).toEqual({ mode: 'week', start: '2100-12-26' });
    expect(shiftView({ mode: 'week', start: '2100-12-26' }, 1)).toBeNull();
  });
});
