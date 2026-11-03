// 香港天文台历表适配器（tools/lunar/adapters/hko-txt.mjs）和生成的 shared/logic/anniv/lunar-data.ts 的抽查（B2 BE-5；R-299、R-306、R-309）。
// 抽查用公认的日期：若干年春节、已知闰月年、冬至等；同时核对 lunar-data.ts 解码后和 cn-months.json 一致、节气全表一致、build() 输出和文件一字不差、只有中国数据时韩国表为空。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convert, parseMonthName, run, verifySums } from '../../tools/lunar/adapters/hko-txt.mjs';
import { build, checkHkoSources, OUT } from '../../tools/lunar/build.mjs';
import { dateOf, dayNum, decodeYears, encodeTerms } from '../../tools/lunar/lib.mjs';
import { LUNAR_CN, LUNAR_KR, TERMS_CN, TERMS_KR } from '../../shared/logic/anniv/lunar-data';

interface M { y: number; m: number; leap: boolean; start: string; days: number }

let months: M[] = [];
let terms: { y: number; terms: string[] }[] = [];
let decoded: M[] = [];
beforeAll(() => {
  ({ months, terms } = run() as { months: M[]; terms: { y: number; terms: string[] }[] });
  decoded = decodeYears(LUNAR_CN) as M[];
});

function find(ms: M[], y: number, m: number, leap = false): M | undefined {
  return ms.find((x) => x.y === y && x.m === m && x.leap === leap);
}

/** 公历日期 → 农历（用 lunar-data.ts 解码结果查） */
function toLunar(date: string): { y: number; m: number; leap: boolean; d: number } | null {
  const n = dayNum(date) as number;
  for (const x of decoded) {
    const s = dayNum(x.start) as number;
    if (n >= s && n < s + x.days) return { y: x.y, m: x.m, leap: x.leap, d: n - s + 1 };
  }
  return null;
}

function term(y: number, i: number): string {
  const offs = TERMS_CN.years[y - TERMS_CN.first];
  if (!offs) throw new Error(`没有 ${y} 年节气`);
  return dateOf((dayNum(`${y}-01-01`) as number) + (offs[i] ?? NaN)) as string;
}

describe('香港天文台历表 → lunar-data.ts 抽查', () => {
  it('春节（正月初一）公历日期', () => {
    const spring: [number, string][] = [
      [1901, '1901-02-19'], [1949, '1949-01-29'], [1984, '1984-02-02'], [2000, '2000-02-05'], [2008, '2008-02-07'],
      [2020, '2020-01-25'], [2023, '2023-01-22'], [2024, '2024-02-10'], [2025, '2025-01-29'], [2026, '2026-02-17'],
      [2033, '2033-01-31'], [2050, '2050-01-23'], [2099, '2099-01-21'],
    ];
    for (const [y, d] of spring) {
      expect(find(decoded, y, 1)?.start, `${y} 年春节`).toBe(d);
      expect(dateOf(LUNAR_CN.years[y - LUNAR_CN.first]?.[0] ?? NaN)).toBe(d);
    }
  });
  it('已知闰月年：2020 闰四月、2023 闰二月、2025 闰六月、2033 闰十一月；2024 无闰月', () => {
    expect(find(decoded, 2020, 4, true)?.start).toBe('2020-05-23');
    expect(find(decoded, 2023, 2, true)?.start).toBe('2023-03-22');
    expect(find(decoded, 2025, 6, true)?.start).toBe('2025-07-25');
    expect(find(decoded, 2033, 11, true)?.start).toBe('2033-12-22');
    expect(decoded.filter((x) => x.y === 2024 && x.leap)).toEqual([]);
    expect(decoded.filter((x) => x.y === 2023)).toHaveLength(13);
  });
  it('常见节日对应的公历日期（中秋、端午、除夕）', () => {
    expect(toLunar('2024-09-17')).toEqual({ y: 2024, m: 8, leap: false, d: 15 });   // 2024 中秋
    expect(toLunar('2023-06-22')).toEqual({ y: 2023, m: 5, leap: false, d: 5 });    // 2023 端午
    expect(toLunar('2025-01-28')).toEqual({ y: 2024, m: 12, leap: false, d: 29 });  // 2024 除夕（腊月小，廿九）
    expect(toLunar('2023-04-01')).toEqual({ y: 2023, m: 2, leap: true, d: 11 });    // 闰二月十一
  });
  it('节气：冬至、立春、清明', () => {
    expect(term(2023, 23)).toBe('2023-12-22');
    expect(term(2024, 23)).toBe('2024-12-21');
    expect(term(2025, 23)).toBe('2025-12-21');
    expect(term(2024, 2)).toBe('2024-02-04');
    expect(term(2025, 6)).toBe('2025-04-04');
    expect(TERMS_CN.first).toBe(1901);
    expect(TERMS_CN.years).toHaveLength(200);
  });
  it('覆盖范围：农历 1901～2099（公历 1901-02-19 起），范围外查不到；中间格式另含首尾不成年的月', () => {
    expect(LUNAR_CN.first).toBe(1901);
    expect(LUNAR_CN.years).toHaveLength(199);
    expect(toLunar('1901-02-18')).toBeNull();
    expect(toLunar('1901-02-19')).toEqual({ y: 1901, m: 1, leap: false, d: 1 });
    expect(decoded.at(-1)?.y).toBe(2099);
    const last = decoded.at(-1) as M;
    expect(dateOf((dayNum(last.start) as number) + last.days)).toBe(find(months, 2100, 1)?.start);
    expect(months[0]).toEqual({ y: 1900, m: 12, leap: false, start: '1901-01-20', days: 30 });
  });
  it('lunar-data.ts 解码后和 cn-months.json 的完整年份逐月一致', () => {
    expect(decoded).toEqual(months.filter((x) => x.y >= 1901 && x.y <= 2099));
  });
  it('节气全表：原始历表转出的 200 年节气编码后和 TERMS_CN 一字不差', () => {
    expect(encodeTerms(terms)).toEqual({ first: TERMS_CN.first, years: TERMS_CN.years });
  });
  it('build() 的输出和磁盘上的 lunar-data.ts 一字不差', () => {
    const r = build() as { ok: boolean; text?: string };
    expect(r.ok).toBe(true);
    expect(r.text).toBe(readFileSync(OUT, 'utf8'));
  });
  it('范围边界：1901-01-01～01-19（农历 1900 年冬月中途）和腊月都查不到；2100 年第 24 个节气（冬至）在', () => {
    for (const d of ['1901-01-01', '1901-01-19', '1901-01-20', '1901-02-18', '2100-02-09', '2100-12-31']) expect(toLunar(d), d).toBeNull();
    expect(term(2100, 23)).toBe('2100-12-22');
    expect(TERMS_CN.years[2100 - TERMS_CN.first]).toHaveLength(24);
  });
  it('2033 闰十一月之后：腊月 2034-01-20 起，跨公历年那天 2034-01-01 = 闰十一月十一', () => {
    expect(find(decoded, 2033, 11, true)?.days).toBe(29);
    expect(find(decoded, 2033, 12)?.start).toBe('2034-01-20');
    expect(toLunar('2033-12-31')).toEqual({ y: 2033, m: 11, leap: true, d: 10 });
    expect(toLunar('2034-01-01')).toEqual({ y: 2033, m: 11, leap: true, d: 11 });
    expect(find(decoded, 2034, 1)?.start).toBe('2034-02-19');
  });
  it('只有中国数据：韩国表为空（运行时按“没有韩国农历”处理）', () => {
    expect(LUNAR_KR.years).toEqual([]);
    expect(TERMS_KR.years).toEqual([]);
  });
});

describe('hko-txt.mjs 适配器细节', () => {
  let dir = '';
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lunar-hko-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('月名：正月、十二月、閏十一月；初二之类不是月名', () => {
    expect(parseMonthName('正月')).toEqual({ m: 1, leap: false });
    expect(parseMonthName('十二月')).toEqual({ m: 12, leap: false });
    expect(parseMonthName('閏十一月')).toEqual({ m: 11, leap: true });
    expect(parseMonthName('初二')).toBeNull();
  });
  it('SHA256 核对：哈希不对、缺文件、目录里多出的文件、重复登记、SHA256SUMS 本身被改都报出来', () => {
    const lines = [];
    for (let y = 1901; y <= 2100; y++) lines.push(`${'0'.repeat(64)} *T${y}c.txt`);
    lines.push(`${'0'.repeat(64)} *T1903c.txt`);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
    writeFileSync(join(dir, 'T1901c.txt'), 'x');
    writeFileSync(join(dir, 'T1800c.txt'), 'x');
    const errs = verifySums(dir) as string[];
    expect(errs.some((e) => e.startsWith('T1901c.txt 的 SHA256 对不上'))).toBe(true);
    expect(errs.some((e) => e === '缺文件 T1902c.txt')).toBe(true);
    expect(errs.some((e) => e.startsWith('SHA256SUMS 本身的哈希对不上'))).toBe(true);
    expect(errs.some((e) => e === 'SHA256SUMS 重复登记 T1903c.txt')).toBe(true);
    expect(errs.some((e) => e.startsWith('原始历表目录里有不该有的 T1800c.txt'))).toBe(true);
    expect(errs.some((e) => e.startsWith('原始历表目录里有不该有的 notes.txt'))).toBe(true);
    expect((verifySums(dir, null) as string[]).some((e) => e.startsWith('SHA256SUMS 本身'))).toBe(false);
    expect(() => run(dir)).toThrow(/原始文件核对没通过/);
  });
  it('原始历表目录不在：适配器和 build --check 的复核都报错，不许跳过', async () => {
    const gone = join(dir, 'no-such-dir');
    expect(verifySums(gone)).toEqual([`缺原始历表目录 ${gone}`]);
    expect(await checkHkoSources(gone)).toMatch(/缺原始历表目录/);
    expect(await checkHkoSources()).toBeNull();
  });
  it('真实目录 SHA256 全部对得上', () => {
    expect(verifySums()).toEqual([]);
  });
  it('农历日跳号、节气顺序错、日期不连续都报错', () => {
    const rows = (start: string, ldays: string[]) => ldays.map((l, i) => ({ date: dateOf((dayNum(start) as number) + i) as string, lday: l, term: '' }));
    const ok = rows('2030-01-01', ['廿九', '三十', '正月', '初二', '初三', '二月']);
    expect(() => convert(ok)).not.toThrow();
    expect(() => convert(rows('2030-01-01', ['廿九', '三十', '正月', '初三', '初四', '二月']))).toThrow(/应为“初二”/);
    const gap = ok.map((r) => ({ ...r }));
    gap[3] = { lday: '初二', term: '', date: '2030-01-09' };
    expect(() => convert(gap)).toThrow(/日期不连续/);
    const t = ok.map((r) => ({ ...r }));
    t[0] = { date: '2030-01-01', lday: '廿九', term: '大寒' };
    expect(() => convert(t)).toThrow(/应为“小寒”/);
  });
});
