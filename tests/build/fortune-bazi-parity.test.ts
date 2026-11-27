// 今日运势卡的排八字（shared/logic/anniv/lunar-fortune.ts 的 baziOf）和开发依赖 lunar-javascript 1.7.7 的 EightChar 对拍（负责人派单第 3 项）。
// • 随机抽 600 个生日（1901～2026，带或不带出生时段），逐柱比年、月、日、时柱
// • lunar-javascript 用 setSect(1)（晚子时日柱算第二天，同方案页 bazi()）；时段取那一段中间（23 点那一段取 23:30，其余取 h:30）
// • 交节当天跳过：那天在交节前后两种月柱都有，本算法按“交节当天算新月”（节气表只精确到日），见 lunar-fortune.ts 文件头
// 放 tests/build（node 项目）不放 tests/shared：Deno 跑 tests/shared，没有这个开发依赖
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { baziOf, type Birth } from '../../shared/logic/anniv/lunar-fortune.ts';

interface EightChar {
  setSect(n: number): void;
  getYear(): string;
  getMonth(): string;
  getDay(): string;
  getTime(): string;
}
interface LunarDay {
  getEightChar(): EightChar;
  getJie(): string;
}
interface LunarLib {
  Solar: { fromYmdHms(y: number, m: number, d: number, h: number, mi: number, s: number): { getLunar(): LunarDay } };
}
const lib = createRequire(import.meta.url)('lunar-javascript') as LunarLib;

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
const HOURS = [null, 23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21] as const;
const DAYS_IN = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

describe('排八字和 lunar-javascript 对拍', () => {
  it('随机 600 个生日，交节当天跳过，其余四柱全部一致', () => {
    let seed = 20261121;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let compared = 0;
    let skipped = 0;
    const bad: string[] = [];
    for (let i = 0; i < 600; i++) {
      const y = 1901 + next(126);
      const m = 1 + next(12);
      const d = 1 + next(DAYS_IN(y, m));
      const b: Birth = { y, m, d, h: HOURS.at(next(HOURS.length)) ?? null };
      const day = lib.Solar.fromYmdHms(y, m, d, 12, 0, 0).getLunar();
      if (day.getJie() !== '') {
        skipped++;
        continue;
      }
      const ec = lib.Solar.fromYmdHms(y, m, d, b.h ?? 12, 30, 0).getLunar().getEightChar();
      ec.setSect(1);
      const want = [ec.getYear(), ec.getMonth(), ec.getDay(), ...(b.h === null ? [] : [ec.getTime()])];
      const got = baziOf(b)?.map(([s, z]) => GAN.charAt(s) + ZHI.charAt(z)) ?? null;
      compared++;
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${y}-${m}-${d} h=${b.h}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThan(550);
    expect(skipped).toBeLessThan(50);
  });
});
