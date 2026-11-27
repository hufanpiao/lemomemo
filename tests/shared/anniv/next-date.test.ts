// shared/logic/anniv/next-date.ts 的单测（B5 S12；架构 5.4；R-94、R-403；TC-B5-19、21、22、23）。
// 农历的期望值用 lunar.ts 的 toSolar 现查（lunar.test.ts 已逐条对过香港天文台的表），这里只核“取哪一次、怎么兜底”。
// 纯日期运算，和进程时区无关：npm run test:tz 三个时区都跑。
import { describe, expect, it } from 'vitest';
import { msAt, todayOf } from '../../../shared/core/date.ts';
import { leapMonthOf, toSolar } from '../../../shared/logic/anniv/lunar.ts';
import {
  annivNextAt, annivNextOf, annivRecOf, calcRecOf, annivState, countdownTarget, datesBetween, occurrenceIn, offsetsOf, onOrAfter, remindTimeOf, upcoming, validDate,
  type AnnivRec,
} from '../../../shared/logic/anniv/next-date.ts';

const SEOUL = 'Asia/Seoul';
const rec = (p: Partial<AnnivRec>): AnnivRec => ({
  kind: 'birthday', calendar: 'solar', lunar_variant: 'cn', month: 1, day: 1, is_leap: false, year: null,
  after_due: 'archive', remind_offsets: null, remind_time: null, created_at: null, ...p,
});

describe('月日合不合格（R-403）', () => {
  it('阳历：2-30、4-31 不行；2-29 没年份可以，平年不行、闰年可以', () => {
    expect(validDate(rec({ month: 2, day: 30 }))).toBe(false);
    expect(validDate(rec({ month: 4, day: 31 }))).toBe(false);
    expect(validDate(rec({ month: 2, day: 29 }))).toBe(true);
    expect(validDate(rec({ month: 2, day: 29, year: 2001 }))).toBe(false);
    expect(validDate(rec({ month: 2, day: 29, year: 2000 }))).toBe(true);
    expect(validDate(rec({ month: 13, day: 1 }))).toBe(false);
    expect(validDate(rec({ month: 1, day: 1, is_leap: true }))).toBe(false);
  });
  it('阴历：三十可以；有年份时那一年要真有这一天（闰月）', () => {
    expect(validDate(rec({ calendar: 'lunar', month: 3, day: 30 }))).toBe(true);
    expect(validDate(rec({ calendar: 'lunar', month: 3, day: 31 }))).toBe(false);
    expect(leapMonthOf(1955, 'cn')).toBe(3);
    expect(validDate(rec({ calendar: 'lunar', month: 3, day: 10, is_leap: true, year: 1955 }))).toBe(true);
    expect(validDate(rec({ calendar: 'lunar', month: 4, day: 10, is_leap: true, year: 1955 }))).toBe(false);
  });
});

describe('下一次（nextDate）', () => {
  it('阳历：今年没过取今年，过了取明年；当天就是今天', () => {
    const r = rec({ month: 10, day: 27 });
    expect(onOrAfter(r, '2026-10-01')?.date).toBe('2026-10-27');
    expect(onOrAfter(r, '2026-10-27')?.date).toBe('2026-10-27');
    expect(onOrAfter(r, '2026-10-28')?.date).toBe('2027-10-27');
  });
  it('阳历 2-29：平年取 2-28，闰年照常', () => {
    const r = rec({ month: 2, day: 29 });
    expect(onOrAfter(r, '2026-01-01')?.date).toBe('2026-02-28');
    expect(onOrAfter(r, '2028-01-01')?.date).toBe('2028-02-29');
  });
  it('阴历腊月：落在下一个公历年的 1、2 月（腊月跨年）', () => {
    const r = rec({ calendar: 'lunar', month: 12, day: 20 });
    const lastYears = toSolar(2025, 12, 20, false, 'cn');   // 农历 2025 年腊月二十 = 公历 2026 年初
    expect(lastYears?.startsWith('2026-0')).toBe(true);
    expect(onOrAfter(r, '2026-01-01')?.date).toBe(lastYears);
    expect(onOrAfter(r, '2026-01-01')?.year).toBe(2025);
    // 过了以后取农历 2026 年腊月二十（公历 2027 年初）
    expect(onOrAfter(r, addOne(lastYears as string))?.date).toBe(toSolar(2026, 12, 20, false, 'cn'));
  });
  it('闰月：当年有闰月用闰月，没有用同号平月（R-403）', () => {
    const r = rec({ calendar: 'lunar', month: 3, day: 10, is_leap: true, year: 1955 });
    expect(leapMonthOf(2026, 'cn')).not.toBe(3);
    expect(onOrAfter(r, '2026-01-01')?.date).toBe(toSolar(2026, 3, 10, false, 'cn'));
    // 找一个有闰三月的年份核对用的是闰月
    const y = [2028, 2031, 2033, 2036, 2039, 2042, 2044, 2047, 2050, 2052, 2055].find((x) => leapMonthOf(x, 'cn') === 3);
    expect(y === undefined).toBe(false);
    expect(occurrenceIn(r, y as number)?.date).toBe(toSolar(y as number, 3, 10, true, 'cn'));
  });
  it('三十不存在用廿九', () => {
    // 找一个小月（29 天）的正月
    const y = [2026, 2027, 2028, 2029, 2030, 2031, 2032].find((x) => toSolar(x, 1, 30, false, 'cn') === null) as number;
    expect(y === undefined).toBe(false);
    expect(occurrenceIn(rec({ calendar: 'lunar', month: 1, day: 30 }), y)?.date).toBe(toSolar(y, 1, 29, false, 'cn'));
  });
  it('闰月三十：那一年闰月只有 29 天时取闰月廿九，不落到平月三十（整块评审第 3 条）', () => {
    // 找一年：闰 m 月只有 29 天、平 m 月有 30 天
    let hit: [number, number] | null = null;
    for (let y = 1901; y <= 2099 && hit === null; y++) {
      const m = leapMonthOf(y, 'cn');
      if (m && toSolar(y, m, 30, true, 'cn') === null && toSolar(y, m, 30, false, 'cn') !== null) hit = [y, m];
    }
    expect(hit === null).toBe(false);
    const [y, m] = hit as [number, number];
    expect(occurrenceIn(rec({ calendar: 'lunar', month: m, day: 30, is_leap: true }), y)?.date).toBe(toSolar(y, m, 29, true, 'cn'));
    // 当年没有闰 m 月：平月三十（有的话）
    const y2 = [y + 1, y + 2, y + 3].find((x) => leapMonthOf(x, 'cn') !== m && toSolar(x, m, 30, false, 'cn') !== null) as number;
    expect(occurrenceIn(rec({ calendar: 'lunar', month: m, day: 30, is_leap: true }), y2)?.date).toBe(toSolar(y2, m, 30, false, 'cn'));
  });
  it('韩国阴历（D1 先不做）、超出农历表的年份算不出', () => {
    expect(onOrAfter(rec({ calendar: 'lunar', lunar_variant: 'kr', month: 3, day: 1 }), '2026-01-01')).toBeNull();
    expect(occurrenceIn(rec({ calendar: 'lunar', month: 3, day: 1 }), 2101)).toBeNull();
    expect(annivState(rec({ calendar: 'lunar', lunar_variant: 'kr', month: 3, day: 1 }), '2026-01-01')).toBeNull();
  });
});

/** annivState 里断言要看的几项（deno 跑的简化版 expect 没有 toMatchObject） */
function brief(s: ReturnType<typeof annivState>): { date: string; past: boolean; days: number; age: number | null } | null {
  return s ? { date: s.next.date, past: s.past, days: s.days, age: s.age } : null;
}

describe('倒数日（R-403）', () => {
  it('有年份：就是那一天；过了 archive 算已过去，yearly 滚到下一次', () => {
    const r = rec({ kind: 'countdown', month: 11, day: 30, year: 2026 });
    expect(brief(annivState(r, '2026-11-13'))).toEqual({ date: '2026-11-30', past: false, days: 17, age: null });
    expect(brief(annivState(r, '2026-12-01'))).toEqual({ date: '2026-11-30', past: true, days: -1, age: null });
    const y = brief(annivState({ ...r, after_due: 'yearly' }, '2026-12-01'));
    expect([y?.date, y?.past]).toEqual(['2027-11-30', false]);
  });
  it('没年份：从创建那天起第一个该月日（当天就是这个月日的取当天）', () => {
    const r = rec({ kind: 'countdown', month: 3, day: 5 });
    expect(countdownTarget(r, '2026-03-05')?.date).toBe('2026-03-05');
    expect(countdownTarget(r, '2026-03-06')?.date).toBe('2027-03-05');
    const s = brief(annivState(r, '2027-03-06', '2026-03-06'));
    expect([s?.date, s?.past]).toEqual(['2027-03-05', true]);
  });
});

describe('周岁、第几年', () => {
  it('有年份才算；阳历按下一次的公历年，阴历按农历年', () => {
    expect(annivState(rec({ month: 10, day: 27, year: 1997 }), '2026-10-01')?.age).toBe(29);
    expect(annivState(rec({ month: 10, day: 27, year: 1997 }), '2026-10-28')?.age).toBe(30);
    expect(annivState(rec({ kind: 'anniversary', month: 11, day: 2, year: 2020 }), '2026-10-01')?.age).toBe(6);
    expect(annivState(rec({ month: 10, day: 27 }), '2026-10-01')?.age).toBeNull();
    const lunar = rec({ calendar: 'lunar', month: 12, day: 20, year: 1990 });
    expect(annivState(lunar, '2026-01-01')?.age).toBe(2025 - 1990);
  });
});

describe('提醒设置（R-94）', () => {
  it('这一条 ?? 设置 ?? {7,1} / 09:00；不合格的设置按出厂', () => {
    expect(offsetsOf(rec({}), {})).toEqual([7, 1]);
    expect(offsetsOf(rec({}), { 'anniv.default_offsets': [3, 0] })).toEqual([3, 0]);
    expect(offsetsOf(rec({ remind_offsets: [1, 14, 1] }), { 'anniv.default_offsets': [3] })).toEqual([14, 1]);
    expect(offsetsOf(rec({}), { 'anniv.default_offsets': [61] })).toEqual([7, 1]);
    expect(remindTimeOf(rec({}), {})).toBe('09:00');
    expect(remindTimeOf(rec({}), { 'anniv.default_time': '20:30' })).toBe('20:30');
    expect(remindTimeOf(rec({ remind_time: '07:15' }), { 'anniv.default_time': '20:30' })).toBe('07:15');
  });
  it('remind_at：下一个还没到的 (next − offset) 的 time，按 current_tz', () => {
    const r = rec({ month: 10, day: 27 });
    const now = msAt('2026-10-13', 600, SEOUL);
    expect(annivNextAt(r, SEOUL, now, {})).toEqual({ next_date: '2026-10-27', remind_at: msAt('2026-10-20', 540, SEOUL), past: false });
    // 提前 7 天那次已经过了，取前一天
    expect(annivNextAt(r, SEOUL, msAt('2026-10-21', 0, SEOUL), {}).remind_at).toBe(msAt('2026-10-26', 540, SEOUL));
    // 当天提醒
    expect(annivNextAt({ ...r, remind_offsets: [0] }, SEOUL, msAt('2026-10-27', 0, SEOUL), {}).remind_at).toBe(msAt('2026-10-27', 540, SEOUL));
  });
  it('这一次的都过了：取明年的第一次；已过去的倒数日不提醒', () => {
    const r = rec({ month: 10, day: 27, remind_offsets: [0] });
    const now = msAt('2026-10-27', 600, SEOUL);
    expect(annivNextAt(r, SEOUL, now, {})).toEqual({ next_date: '2026-10-27', remind_at: msAt('2027-10-27', 540, SEOUL), past: false });
    const cd = rec({ kind: 'countdown', month: 11, day: 30, year: 2026, remind_offsets: [0] });
    expect(annivNextAt(cd, SEOUL, msAt('2026-11-30', 600, SEOUL), {})).toEqual({ next_date: '2026-11-30', remind_at: null, past: false });
    expect(annivNextAt(cd, SEOUL, msAt('2026-12-01', 0, SEOUL), {})).toEqual({ next_date: '2026-11-30', remind_at: null, past: true });
  });
  it('跨时区：时刻按 current_tz 浮动', () => {
    const r = rec({ month: 10, day: 27, remind_offsets: [0] });
    const la = 'America/Los_Angeles';
    expect(annivNextAt(r, la, msAt('2026-10-01', 0, la), {}).remind_at).toBe(msAt('2026-10-27', 540, la));
  });
});

describe('行 → AnnivRec、annivNextOf（push-dispatch 接口）', () => {
  it('认不出的枚举、月日越界：null / 抛 bad_anniv', () => {
    // 能算的行只有一处判断（整块评审第 23 条）：认不出的、韩国阴历都回 null
    expect(calcRecOf({ kind: 'birthday', calendar: 'lunar', lunar_variant: 'kr', month: 1, day: 1 })).toBeNull();
    expect(calcRecOf({ kind: 'party', calendar: 'solar', month: 1, day: 1 })).toBeNull();
    expect(calcRecOf({ kind: 'birthday', calendar: 'lunar', lunar_variant: 'cn', month: 1, day: 1 })?.lunar_variant).toBe('cn');
    expect(annivRecOf({ kind: 'party', calendar: 'solar', month: 1, day: 1 })).toBeNull();
    expect(annivRecOf({ kind: 'birthday', calendar: 'solar', month: 2, day: 30 })).toBeNull();
    expect(() => annivNextOf({ kind: 'x' }, { tz: SEOUL, now: 0, settings: {} })).toThrow('bad_anniv');
  });
  it('缺的列按默认：lunar_variant cn、after_due archive', () => {
    const r = annivRecOf({ kind: 'countdown', calendar: 'solar', month: 3, day: 5, created_at: msAt('2026-03-06', 0, SEOUL) });
    expect([r?.lunar_variant, r?.after_due, r?.year]).toEqual(['cn', 'archive', null]);
    const now = msAt('2026-03-10', 0, SEOUL);
    expect(annivNextOf({ kind: 'countdown', calendar: 'solar', month: 3, day: 5, created_at: msAt('2026-03-06', 0, SEOUL) }, { tz: SEOUL, now, settings: {} }))
      .toEqual({ next_date: '2027-03-05', remind_at: msAt('2027-02-26', 540, SEOUL), past: false });
  });
});

describe('接下来几次、月历菱形', () => {
  it('upcoming：每年的取 3 次；倒数日只有一次', () => {
    expect(upcoming(rec({ month: 10, day: 27 }), '2026-11-01', 3)).toEqual(['2027-10-27', '2028-10-27', '2029-10-27']);
    expect(upcoming(rec({ kind: 'countdown', month: 11, day: 30, year: 2026 }), '2026-11-01', 3)).toEqual(['2026-11-30']);
  });
  it('datesBetween：一个月历窗口里的日子', () => {
    expect(datesBetween(rec({ month: 10, day: 27 }), '2026-09-28', '2026-11-08')).toEqual(['2026-10-27']);
    expect(datesBetween(rec({ month: 10, day: 27 }), '2026-11-01', '2027-11-01')).toEqual(['2027-10-27']);
    const cd = rec({ kind: 'countdown', month: 11, day: 30, year: 2026 });
    expect(datesBetween(cd, '2026-11-01', '2028-12-31')).toEqual(['2026-11-30']);
    expect(datesBetween({ ...cd, after_due: 'yearly' }, '2025-11-01', '2027-12-31')).toEqual(['2026-11-30', '2027-11-30']);
  });
});

function addOne(d: string): string {
  return todayOf(msAt(d, 0, 'UTC') + 86_400_000, 'UTC');
}
