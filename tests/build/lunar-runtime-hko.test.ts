// shared/logic/anniv/lunar.ts（运行时换算）和香港天文台原始历表逐日对拍（B2 BE-5）。
// ① 全量：1901-01-01～2100-12-31 每一天，toLunar、solarTermOf 和原始表上的农历日、节气逐条一致（开头 19 天月名推不出，必须是 null）；
// ② 随机抽样（固定种子，可复现）：抽 3000 天，toSolar(toLunar(d)) 回到 d；
// ③ 运行时解码和 tools/lunar/lib.mjs 的 decodeYears 对同一张表逐月一致（覆盖范围首尾都在）。
// 纯日期运算，和进程时区无关：用 node build/run_tz_tests.mjs --project node tests/build/lunar-runtime-hko.test.ts 三个时区各跑一遍。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIRST_YEAR, LAST_YEAR, parseMonthName, parseYearFile, RAW, TERMS } from '../../tools/lunar/adapters/hko-txt.mjs';
import { decodeYears } from '../../tools/lunar/lib.mjs';
import { lunarMonthDays, solarTermOf, toLunar, toSolar, type LunarDate } from '../../shared/logic/anniv/lunar.ts';
import { LUNAR_CN } from '../../shared/logic/anniv/lunar-data.ts';

interface Row { date: string; lday: string; term: string }

const DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const TERM_IDX = new Map((TERMS as [string, string][]).map(([t], i) => [t, i]));

const rows: Row[] = [];
beforeAll(() => {
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) rows.push(...(parseYearFile(readFileSync(join(RAW, `T${y}c.txt`), 'utf8'), y) as Row[]));
});

/** 原始表上这一天的农历（月名行 = 初一）；月名之前的开头几天返回 null */
function expected(): (LunarDate | null)[] {
  const out: (LunarDate | null)[] = [];
  let cur: { year: number; month: number; isLeap: boolean } | null = null;
  let day = 0;
  let year = 1900;
  for (const r of rows) {
    const mn = parseMonthName(r.lday) as { m: number; leap: boolean } | null;
    if (mn) {
      if (mn.m === 1 && !mn.leap) year = Number(r.date.slice(0, 4));
      cur = { year, month: mn.m, isLeap: mn.leap };
      day = 1;
    } else if (cur) {
      day++;
      expect(DAY_NAMES[day - 1], r.date).toBe(r.lday);
    }
    out.push(cur ? { year: cur.year, month: cur.month, day, isLeap: cur.isLeap } : null);
  }
  return out;
}

/** 固定种子的伪随机（mulberry32），抽样可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('lunar.ts 和香港天文台原始历表逐日对拍', () => {
  it('原始表 1901-01-01～2100-12-31 共 73049 天', () => {
    expect(rows).toHaveLength(73049);
    expect(rows[0]?.date).toBe('1901-01-01');
    expect(rows.at(-1)?.date).toBe('2100-12-31');
  });

  it('全量逐日：toLunar 和原始表一致（开头 19 天为 null）', () => {
    const want = expected();
    const bad: string[] = [];
    rows.forEach((r, i) => {
      const got = toLunar(r.date, 'cn');
      const w = want[i] ?? null;
      if (JSON.stringify(got) !== JSON.stringify(w)) bad.push(`${r.date}：期望 ${JSON.stringify(w)}，实际 ${JSON.stringify(got)}`);
    });
    expect(bad.slice(0, 10)).toEqual([]);
    expect(want.filter((x) => x === null)).toHaveLength(19);
  });

  it('全量逐日：solarTermOf 和原始表的节气一致（含不是节气的日子为 null）', () => {
    const bad: string[] = [];
    let n = 0;
    for (const r of rows) {
      const w = r.term ? TERM_IDX.get(r.term) : null;
      if (r.term) n++;
      const got = solarTermOf(r.date, 'cn');
      if (got !== (w ?? null)) bad.push(`${r.date}：期望 ${w}，实际 ${got}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(n).toBe(200 * 24);
  });

  it('随机抽样 3000 天（种子 20261103）：toSolar(toLunar(d)) 回到 d，月天数和原始表一致', () => {
    const rand = rng(20261103);
    const want = expected();
    let checked = 0;
    for (let k = 0; k < 3000; k++) {
      const i = Math.floor(rand() * rows.length);
      const r = rows[i] as Row;
      const l = want[i];
      if (!l) {
        expect(toLunar(r.date, 'cn')).toBeNull();
        continue;
      }
      expect(toSolar(l.year, l.month, l.day, l.isLeap, 'cn'), r.date).toBe(r.date);
      // 原始表上这个月有多少天：从初一往后数到下一个月名
      let j = i - (l.day - 1);
      let len = 0;
      do { len++; j++; } while (j < rows.length && !parseMonthName((rows[j] as Row).lday));
      const days = lunarMonthDays(l.year, l.month, l.isLeap, 'cn');
      if (j < rows.length) expect(days, `${l.year}-${l.isLeap ? '闰' : ''}${l.month}`).toBe(len);
      else expect(days).toBeNull();   // 数据结尾还没结束的月（2100 腊月）
      checked++;
    }
    expect(checked).toBeGreaterThan(2900);
  });

  it('运行时解码和 tools/lunar/lib.mjs 的 decodeYears 逐月一致：每个月的初一和最后一天都对得上', () => {
    const months = decodeYears(LUNAR_CN) as { y: number; m: number; leap: boolean; start: string; days: number; open?: boolean }[];
    expect(months).toHaveLength(2474);
    for (const x of months) {
      expect(toSolar(x.y, x.m, 1, x.leap, 'cn')).toBe(x.start);
      expect(toLunar(x.start, 'cn')).toEqual({ year: x.y, month: x.m, day: 1, isLeap: x.leap });
      if (!x.open) expect(lunarMonthDays(x.y, x.m, x.leap, 'cn')).toBe(x.days);
    }
  });
});
