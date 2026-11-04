// shared/logic/anniv/lunar.ts 的单测（B2 BE-5；架构 5.4“数据”、第 9 节单元 lunar；TC-B2-87、TC-B5-19 的边界部分）。
// 期望值都从香港天文台原始历表（tools/lunar/raw/hko/）逐条核对过；全量逐日对拍在 tests/build/lunar-runtime-hko.test.ts。
// 纯日期运算，和进程时区无关：npm run test:tz 在 UTC、首尔、洛杉矶各跑一遍；Deno（tests/shared）也跑。
import { describe, expect, it } from 'vitest';
import { LUNAR_CN, type LunarTable } from '../../../shared/logic/anniv/lunar-data.ts';
import {
  leapMonthIn, lunarMonthDaysIn, lunarRangeIn, toLunarIn, toSolarIn,
  leapMonthOf, lunarCellText, lunarDayInfo, lunarMonthDays, lunarMonthName, lunarRange, lunarText,
  SOLAR_TERM_NAMES, solarTermOf, solarTermsOfYear, toLunar, toSolar,
} from '../../../shared/logic/anniv/lunar.ts';

const L = (year: number, month: number, day: number, isLeap = false) => ({ year, month, day, isLeap });

describe('覆盖范围和边界年', () => {
  it('中国：公历 1901-01-20～2100-12-31；韩国暂无数据', () => {
    expect(lunarRange('cn')).toEqual({ from: '1901-01-20', to: '2100-12-31' });
    expect(lunarRange('kr')).toBeNull();
  });
  it('1900：只有腊月（1901-01-20 起 30 天）；之前查不到；1900 年闰月不知道', () => {
    expect(toLunar('1901-01-19', 'cn')).toBeNull();
    expect(toLunar('1901-01-01', 'cn')).toBeNull();
    expect(toLunar('1900-06-01', 'cn')).toBeNull();
    expect(toLunar('1901-01-20', 'cn')).toEqual(L(1900, 12, 1));
    expect(toLunar('1901-02-18', 'cn')).toEqual(L(1900, 12, 30));
    expect(toSolar(1900, 12, 1, false, 'cn')).toBe('1901-01-20');
    expect(toSolar(1900, 11, 15, false, 'cn')).toBeNull();
    expect(toSolar(1900, 1, 1, false, 'cn')).toBeNull();
    expect(leapMonthOf(1900, 'cn')).toBeNull();
    expect(lunarMonthDays(1900, 12, false, 'cn')).toBe(30);
  });
  it('1901 春节 1901-02-19；1899 及以前、2101 及以后查不到', () => {
    expect(toLunar('1901-02-19', 'cn')).toEqual(L(1901, 1, 1));
    expect(toSolar(1901, 1, 1, false, 'cn')).toBe('1901-02-19');
    expect(toSolar(1899, 1, 1, false, 'cn')).toBeNull();
    expect(toLunar('2101-01-01', 'cn')).toBeNull();
    expect(toSolar(2101, 1, 1, false, 'cn')).toBeNull();
  });
  it('2100：春节 2100-02-09；腊月初一 2100-12-31 在，初二起超出数据；腊月大小、有没有闰腊月都不知道', () => {
    expect(toLunar('2100-02-08', 'cn')).toEqual(L(2099, 12, 30));
    expect(toLunar('2100-02-09', 'cn')).toEqual(L(2100, 1, 1));
    expect(toLunar('2100-12-30', 'cn')).toEqual(L(2100, 11, 30));
    expect(toLunar('2100-12-31', 'cn')).toEqual(L(2100, 12, 1));
    expect(toSolar(2100, 12, 1, false, 'cn')).toBe('2100-12-31');
    expect(toSolar(2100, 12, 2, false, 'cn')).toBeNull();
    expect(lunarMonthDays(2100, 12, false, 'cn')).toBeNull();
    expect(lunarMonthDays(2100, 11, false, 'cn')).toBe(30);
    expect(leapMonthOf(2100, 'cn')).toBeNull();   // 腊月之后表就结束了（open），闰腊月可能在表外，不知道
  });
});

describe('春节前后、腊月小月', () => {
  it('2026 春节 02-17：前一天 02-16 是 2025 年腊月廿九（腊月小，没有三十）', () => {
    expect(toLunar('2026-02-15', 'cn')).toEqual(L(2025, 12, 28));
    expect(toLunar('2026-02-16', 'cn')).toEqual(L(2025, 12, 29));
    expect(toLunar('2026-02-17', 'cn')).toEqual(L(2026, 1, 1));
    expect(toLunar('2026-02-18', 'cn')).toEqual(L(2026, 1, 2));
    expect(lunarMonthDays(2025, 12, false, 'cn')).toBe(29);
    expect(toSolar(2025, 12, 30, false, 'cn')).toBeNull();
    expect(toSolar(2025, 12, 29, false, 'cn')).toBe('2026-02-16');
  });
  it('2025 春节 01-29：腊月廿九 01-28 是 2024 年除夕', () => {
    expect(toLunar('2025-01-28', 'cn')).toEqual(L(2024, 12, 29));
    expect(toLunar('2025-01-29', 'cn')).toEqual(L(2025, 1, 1));
    expect(toSolar(2024, 12, 30, false, 'cn')).toBeNull();
  });
  it('2099 春节 01-21：前一天腊月三十（腊月大）', () => {
    expect(toLunar('2099-01-20', 'cn')).toEqual(L(2098, 12, 30));
    expect(toSolar(2098, 12, 30, false, 'cn')).toBe('2099-01-20');
  });
});

describe('闰月', () => {
  it('2023 闰二月：03-22 起，二月三十 03-21；闰二月廿九 04-19，三月初一 04-20', () => {
    expect(leapMonthOf(2023, 'cn')).toBe(2);
    expect(toLunar('2023-03-21', 'cn')).toEqual(L(2023, 2, 30));
    expect(toLunar('2023-03-22', 'cn')).toEqual(L(2023, 2, 1, true));
    expect(toLunar('2023-04-19', 'cn')).toEqual(L(2023, 2, 29, true));
    expect(toLunar('2023-04-20', 'cn')).toEqual(L(2023, 3, 1));
    expect(toSolar(2023, 2, 1, true, 'cn')).toBe('2023-03-22');
    expect(toSolar(2023, 2, 30, true, 'cn')).toBeNull();
    expect(lunarMonthDays(2023, 2, true, 'cn')).toBe(29);
  });
  it('闰月当年不存在 → null（同号平月的兜底归 anniv.nextDate）；2024 无闰月', () => {
    expect(leapMonthOf(2024, 'cn')).toBe(0);
    expect(toSolar(2024, 2, 1, true, 'cn')).toBeNull();
    expect(toSolar(2023, 3, 1, true, 'cn')).toBeNull();
  });
  it('2025 闰六月 07-25；2033 闰十一月 12-22 跨公历年', () => {
    expect(toSolar(2025, 6, 1, true, 'cn')).toBe('2025-07-25');
    expect(leapMonthOf(2033, 'cn')).toBe(11);
    expect(toSolar(2033, 11, 1, true, 'cn')).toBe('2033-12-22');
    expect(toLunar('2034-01-01', 'cn')).toEqual(L(2033, 11, 11, true));
  });
});

describe('节气', () => {
  it('交节当天：2026-10-23 霜降、2024-02-04 立春、2024-12-21 冬至、2033-12-21 冬至、2027-01-05 小寒', () => {
    expect(solarTermOf('2026-10-23', 'cn')).toBe(19);
    expect(SOLAR_TERM_NAMES['zh-CN'][19]).toBe('霜降');
    expect(solarTermOf('2024-02-04', 'cn')).toBe(2);
    expect(solarTermOf('2024-12-21', 'cn')).toBe(23);
    expect(solarTermOf('2033-12-21', 'cn')).toBe(23);
    expect(solarTermOf('2027-01-05', 'cn')).toBe(0);
    expect(solarTermOf('2026-10-22', 'cn')).toBeNull();
    expect(solarTermOf('2026-10-24', 'cn')).toBeNull();
  });
  it('边界年：1901 立春 02-04、冬至 12-22；2100 冬至 12-22；1900、2101 没有数据；韩国暂无', () => {
    expect(solarTermOf('1901-02-04', 'cn')).toBe(2);
    expect(solarTermOf('1901-12-22', 'cn')).toBe(23);
    expect(solarTermOf('2100-12-22', 'cn')).toBe(23);
    expect(solarTermOf('1900-12-22', 'cn')).toBeNull();
    expect(solarTermOf('2101-01-05', 'cn')).toBeNull();
    expect(solarTermOf('2026-10-23', 'kr')).toBeNull();
    expect(solarTermsOfYear(2101, 'cn')).toBeNull();
  });
  it('solarTermsOfYear：24 个、递增、和 solarTermOf 一致', () => {
    const list = solarTermsOfYear(2026, 'cn') ?? [];
    expect(list).toHaveLength(24);
    list.forEach((d, i) => {
      expect(solarTermOf(d, 'cn')).toBe(i);
      if (i > 0) expect(d > (list[i - 1] ?? '')).toBe(true);
    });
    expect(SOLAR_TERM_NAMES['zh-CN']).toHaveLength(24);
    expect(SOLAR_TERM_NAMES['ko-KR']).toHaveLength(24);
    expect(SOLAR_TERM_NAMES['ko-KR'][19]).toBe('상강');
  });
});

describe('参数和韩国版本', () => {
  it('不存在的日期、非整数、越界一律 null；格式不对的公历日期抛 bad_date', () => {
    expect(toSolar(2026, 0, 1, false, 'cn')).toBeNull();
    expect(toSolar(2026, 13, 1, false, 'cn')).toBeNull();
    expect(toSolar(2026, 1, 0, false, 'cn')).toBeNull();
    expect(toSolar(2026, 1, 31, false, 'cn')).toBeNull();
    expect(toSolar(2026, 1.5, 1, false, 'cn')).toBeNull();
    expect(toSolar(Number.NaN, 1, 1, false, 'cn')).toBeNull();
    expect(() => toLunar('2026-02-30', 'cn')).toThrow('bad_date');
    expect(() => toLunar('2026/02/01', 'cn')).toThrow('bad_date');
  });
  it('韩国数据没到：toLunar、toSolar、lunarMonthDays、leapMonthOf 都返回 null，不回退成中国', () => {
    expect(toLunar('2026-02-17', 'kr')).toBeNull();
    expect(toSolar(2026, 1, 1, false, 'kr')).toBeNull();
    expect(lunarMonthDays(2026, 1, false, 'kr')).toBeNull();
    expect(leapMonthOf(2026, 'kr')).toBeNull();
  });
});

describe('显示文字', () => {
  it('中文：月名、完整写法、格子短写法（初一显示月名）', () => {
    expect(lunarMonthName(1, false, 'zh-CN')).toBe('正月');
    expect(lunarMonthName(11, false, 'zh-CN')).toBe('冬月');
    expect(lunarMonthName(12, false, 'zh-CN')).toBe('腊月');
    expect(lunarMonthName(2, true, 'zh-CN')).toBe('闰二月');
    expect(lunarText(L(2026, 9, 15), 'zh-CN')).toBe('九月十五');
    expect(lunarText(L(2023, 2, 11, true), 'zh-CN')).toBe('闰二月十一');
    const days = [1, 2, 10, 11, 19, 20, 21, 29, 30].map((d) => lunarCellText(L(2026, 9, d), 'zh-CN'));
    expect(days).toEqual(['九月', '初二', '初十', '十一', '十九', '二十', '廿一', '廿九', '三十']);
  });
  it('韩文：月名、完整写法、格子短写法', () => {
    expect(lunarMonthName(9, false, 'ko-KR')).toBe('9월');
    expect(lunarMonthName(2, true, 'ko-KR')).toBe('윤2월');
    expect(lunarText(L(2026, 9, 15), 'ko-KR')).toBe('9월 15일');
    expect(lunarCellText(L(2026, 9, 1), 'ko-KR')).toBe('9월');
    expect(lunarCellText(L(2026, 9, 15), 'ko-KR')).toBe('9.15');
    expect(lunarCellText(L(2023, 2, 11, true), 'ko-KR')).toBe('윤2.11');
  });
  it('lunarDayInfo：中文界面用中国的；节气当天两项都给；韩文界面韩国没数据时什么都不给', () => {
    expect(lunarDayInfo('2026-10-23', 'zh-CN')).toEqual({ lunar: '十四', solarTerm: '霜降' });
    expect(lunarDayInfo('2026-10-24', 'zh-CN')).toEqual({ lunar: '十五' });
    expect(lunarDayInfo('2026-02-17', 'zh-CN')).toEqual({ lunar: '正月' });
    expect(lunarDayInfo('1901-01-01', 'zh-CN')).toEqual({});
    expect(lunarDayInfo('2026-10-23', 'ko-KR')).toEqual({});
  });
});

/** 'YYYY-MM-DD' → 相对 1970-01-01 的天数（合成表用） */
const dn = (s: string): number => Math.round(Date.parse(`${s}T00:00:00Z`) / 86_400_000);

describe('合成表（代码审查 M1、⑤）', () => {
  // 【合成数据】虚构的 2090 年：正月初一 2090-01-20，十二个平月加闰腊月共 13 个月，大小月交替（第 1 个月大）
  const bits = (() => {
    let b = 0;
    for (let i = 0; i < 13; i += 2) b |= 1 << i;
    return b | (12 << 13);
  })();
  const LEAP12: LunarTable = { first: 2090, years: [[dn('2090-01-20'), bits]], head: [], tail: [], end: 0, open: false };
  const total = Array.from({ length: 13 }, (_, i) => ((bits >> i) & 1 ? 30 : 29)).reduce((a, b) => a + b, 0);
  const T: LunarTable = { ...LEAP12, end: dn('2090-01-20') + total };

  it('闰腊月：排在腊月后面也找得到，leapMonthIn = 12；闰腊月初一、最后一天能换算', () => {
    expect(leapMonthIn(T, 2090)).toBe(12);
    const leapStart = toSolarIn(T, 2090, 12, 1, true);
    const plainStart = toSolarIn(T, 2090, 12, 1, false);
    expect(leapStart !== null && plainStart !== null && leapStart > plainStart).toBe(true);
    expect(toLunarIn(T, leapStart ?? '')).toEqual(L(2090, 12, 1, true));
    expect(lunarMonthDaysIn(T, 2090, 12, true)).toBe(30);   // 第 13 个月（下标 12）是大月
    expect(toSolarIn(T, 2090, 12, 30, true)).not.toBeNull();
    expect(leapMonthIn(T, 2089)).toBeNull();
  });
  it('end 截断：end 之后的日子查不到（去掉 n >= end 的判断这条就会失败）', () => {
    const cut: LunarTable = { ...LEAP12, end: dn('2090-01-20') + 3 };
    expect(toLunarIn(cut, '2090-01-22')).toEqual(L(2090, 1, 3));
    expect(toLunarIn(cut, '2090-01-23')).toBeNull();
    expect(toSolarIn(cut, 2090, 1, 4, false)).toBeNull();
    expect(lunarRangeIn(cut)).toEqual({ from: '2090-01-20', to: '2090-01-22' });
  });
  it('open：最后一个月没结束时，最后一个月的天数和没找到闰月的那年都返回 null', () => {
    const noLeap = bits & 0x1fff;   // 去掉闰月位：12 个月
    const open: LunarTable = { first: 2090, years: [[dn('2090-01-20'), noLeap]], head: [], tail: [], end: dn('2090-01-20') + 300, open: true };
    expect(lunarMonthDaysIn(open, 2090, 12, false)).toBeNull();
    expect(leapMonthIn(open, 2090)).toBeNull();
    expect(leapMonthIn({ ...open, open: false }, 2090)).toBe(0);
  });
});

describe('逐年闰月和数据表的闰月位一致（代码审查 M1）', () => {
  it('1901～2099 每一年 leapMonthOf 等于 LUNAR_CN.years 的 bit 13～16', () => {
    const bad: string[] = [];
    LUNAR_CN.years.forEach(([, b], k) => {
      const y = LUNAR_CN.first + k;
      const want = (b >> 13) & 0xf;
      if (leapMonthOf(y, 'cn') !== want) bad.push(`${y}：期望 ${want}，实际 ${leapMonthOf(y, 'cn')}`);
    });
    expect(bad).toEqual([]);
    expect(LUNAR_CN.years).toHaveLength(199);
  });
});

describe('版本参数传错（代码审查 ②）', () => {
  const bogus = 'jp' as unknown as 'cn';
  it('一律返回 null，不抛 TypeError；日期格式不对照样抛 bad_date', () => {
    expect(toLunar('2026-02-17', bogus)).toBeNull();
    expect(toSolar(2026, 1, 1, false, bogus)).toBeNull();
    expect(lunarMonthDays(2026, 1, false, bogus)).toBeNull();
    expect(leapMonthOf(2026, bogus)).toBeNull();
    expect(lunarRange(bogus)).toBeNull();
    expect(solarTermOf('2026-10-23', bogus)).toBeNull();
    expect(solarTermsOfYear(2026, bogus)).toBeNull();
    expect(() => toLunar('2026-02-30', bogus)).toThrow('bad_date');
    expect(lunarDayInfo('2026-10-23', 'en-US' as unknown as 'zh-CN')).toEqual({ lunar: '十四', solarTerm: '霜降' });
  });
});
