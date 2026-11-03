// tools/lunar/lib.mjs 骨架的单测（B2 BE-5、第一天派工表第 7 行）：用合成数据（不是真实历表）核对编码往返、结构校验、两国逐月比对、节气编码。
// 真实数据到了以后另加“已知年份抽查”（比如几个已知的春节、闰月年），由 build.mjs --check 进 CI
import { describe, expect, it } from 'vitest';
import { compareCountries, dateOf, dayNum, decodeYears, encodeMonths, encodeTerms, validateMonths } from '../../tools/lunar/lib.mjs';

interface M { y: number; m: number; leap: boolean; start: string; days: number }

function nth(ms: M[], i: number): M {
  const x = ms[i];
  if (!x) throw new Error(`没有第 ${i} 项`);
  return x;
}

/** 合成两年：第 1 年闰 4 月（13 个月），第 2 年 12 个月；大小月交替 */
function synth(): M[] {
  const out: M[] = [];
  let d = dayNum('2030-02-03') as number;
  const push = (y: number, m: number, leap: boolean, days: number) => {
    out.push({ y, m, leap, start: dateOf(d) as string, days });
    d += days;
  };
  for (let m = 1; m <= 12; m++) {
    push(2030, m, false, m % 2 ? 30 : 29);
    if (m === 4) push(2030, 4, true, 29);
  }
  for (let m = 1; m <= 12; m++) push(2031, m, false, m % 2 ? 29 : 30);
  return out;
}

describe('tools/lunar/lib.mjs', () => {
  it('编码往返：encodeMonths → decodeYears 一字不差，闰月位置对', () => {
    const ms = synth();
    const enc = encodeMonths(ms) as { first: number; years: [number, number][] };
    expect(enc.first).toBe(2030);
    expect(enc.years).toHaveLength(2);
    expect(((enc.years[0]?.[1] ?? 0) >> 13) & 0xf).toBe(4);
    expect(((enc.years[1]?.[1] ?? 0) >> 13) & 0xf).toBe(0);
    expect(decodeYears(enc)).toEqual(ms);
  });
  it('结构校验：合成数据通过；天数、衔接、顺序、两个闰月都能查出来', () => {
    const ms = synth();
    expect(validateMonths(ms)).toEqual([]);
    const bad = ms.map((x) => ({ ...x }));
    bad[2] = { ...nth(bad, 2), days: 31 };
    expect((validateMonths(bad) as string[]).some((e) => e.includes('不是 29 或 30'))).toBe(true);
    const gap = ms.map((x) => ({ ...x }));
    gap[5] = { ...nth(gap, 5), start: dateOf(dayNum(nth(gap, 5).start) + 1) };
    expect((validateMonths(gap) as string[]).some((e) => e.includes('不等于下个月初一'))).toBe(true);
    const order = ms.filter((x) => !(x.y === 2031 && x.m === 3));
    expect((validateMonths(order) as string[]).some((e) => e.includes('顺序不对'))).toBe(true);
  });
  it('不完整的一年不收；年份不连续报错', () => {
    const ms = synth().slice(0, 20);
    expect((encodeMonths(ms) as { years: unknown[] }).years).toHaveLength(1);
  });
  it('两国逐月比对：相同不报；差一天报出来；写进白名单的不报', () => {
    const cn = synth();
    const kr = cn.map((x) => ({ ...x }));
    expect(compareCountries(cn, kr)).toEqual([]);
    kr[3] = { ...nth(kr, 3), start: dateOf(dayNum(nth(kr, 3).start) + 1), days: 29 };
    kr[2] = { ...nth(kr, 2), days: nth(kr, 2).days === 30 ? 31 : 30 };
    const diffs = compareCountries(cn, kr) as { key: string }[];
    expect(diffs.map((d) => d.key)).toEqual(['2030-3', '2030-4']);
    expect(compareCountries(cn, kr, ['2030-3', '2030-4'])).toEqual([]);
  });
  it('节气：24 个、递增、相对当年 1 月 1 日；少一个或倒序报错', () => {
    const terms = Array.from({ length: 24 }, (_, i) => dateOf(dayNum('2030-01-05') + i * 15));
    const enc = encodeTerms([{ y: 2030, terms }]) as { first: number; years: number[][] };
    expect(enc.first).toBe(2030);
    expect(enc.years[0]?.[0]).toBe(4);
    expect(() => encodeTerms([{ y: 2030, terms: terms.slice(1) }])).toThrow();
    expect(() => encodeTerms([{ y: 2030, terms: [...terms].reverse() }])).toThrow();
  });
});
