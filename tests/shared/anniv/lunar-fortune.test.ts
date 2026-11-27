// shared/logic/anniv/lunar-fortune.ts 的单测（今日运势卡，负责人 11-21 定稿“八字 B 版”）。
// 八字期望值由开发依赖 lunar-javascript 1.7.7 的 EightChar（setSect(1)，23 点算第二天）给出；随机几百个生日的对拍在 tests/build/fortune-bazi-parity.test.ts
// （本文件 Deno 也跑，不能引 lunar-javascript）。1992-06-12 在 2026-11-21 的整张卡和方案页 方案-八字-B.html 的 fortune() 逐项对过。
// 纯日期运算，和进程时区无关：npm run test:tz 在 UTC、首尔、洛杉矶各跑一遍
import { describe, expect, it } from 'vitest';
import { addDays, type DateStr } from '../../../shared/core/date.ts';
import {
  FORTUNE_CATS,
  FORTUNE_COLORS,
  FORTUNE_DAY_NAMES,
  FORTUNE_ME,
  FORTUNE_TIPS,
  baziOf,
  dayTypeOf,
  fortuneOf,
  tipIndex,
  type Birth,
  type Pillar,
} from '../../../shared/logic/anniv/lunar-fortune.ts';

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
const names = (p: readonly Pillar[] | null): string[] | null => p?.map(([s, z]) => GAN.charAt(s) + ZHI.charAt(z)) ?? null;
const B = (y: number, m: number, d: number, h: number | null = null): Birth => ({ y, m, d, h });

describe('lunar-fortune 排八字', () => {
  it('1992-06-12：壬申 丙午 己未；填了 9 点那一段（巳时）加时柱己巳', () => {
    expect(names(baziOf(B(1992, 6, 12)))).toEqual(['壬申', '丙午', '己未']);
    expect(names(baziOf(B(1992, 6, 12, 9)))).toEqual(['壬申', '丙午', '己未', '己巳']);
  });

  it('年柱按立春换年：2024-02-03 还是癸卯年、乙丑月，2024-02-05 是甲辰年、丙寅月', () => {
    expect(names(baziOf(B(2024, 2, 3)))?.slice(0, 2)).toEqual(['癸卯', '乙丑']);
    expect(names(baziOf(B(2024, 2, 5)))?.slice(0, 2)).toEqual(['甲辰', '丙寅']);
  });

  it('交节当天算新月（已知口径，节气表只精确到日、按中国时间）：2024-02-04 立春当天就是甲辰年丙寅月；2024-03-05 惊蛰当天是丁卯月、前一天还是丙寅月', () => {
    expect(names(baziOf(B(2024, 2, 4)))?.slice(0, 2)).toEqual(['甲辰', '丙寅']);
    expect(names(baziOf(B(2024, 3, 4)))?.at(1)).toBe('丙寅');
    expect(names(baziOf(B(2024, 3, 5)))?.at(1)).toBe('丁卯');
    // 时辰整点切、不挪半小时：0 点出生和 23 点那一段（第二天子时）不是同一段；1 点那一段是丑时
    expect(names(baziOf(B(2024, 3, 5, 1)))?.at(3)?.charAt(1)).toBe('丑');
  });

  it('23 点那一段算第二天：1990-01-01 23 点日柱丁卯（当天是丙寅）、时柱庚子；2000-01-01 23 点己未日甲子时、1 点那一段戊午日癸丑时', () => {
    expect(names(baziOf(B(1990, 1, 1)))?.at(2)).toBe('丙寅');
    expect(names(baziOf(B(1990, 1, 1, 23)))).toEqual(['己巳', '丙子', '丁卯', '庚子']);
    expect(names(baziOf(B(2000, 1, 1, 23)))?.slice(2)).toEqual(['己未', '甲子']);
    expect(names(baziOf(B(2000, 1, 1, 1)))?.slice(2)).toEqual(['戊午', '癸丑']);
  });

  it('出生年没有节气表（1900 年）：回 null，fortuneOf 也回 null', () => {
    expect(baziOf(B(1900, 6, 1))).toBeNull();
    expect(fortuneOf(B(1900, 6, 1), '2026-11-21')).toBeNull();
  });
});

describe('lunar-fortune 当天运势', () => {
  it('1992-06-12 在 2026-11-21：3 星，“身边人和你想到一块…”（同方案页）；海军蓝、幸运数字 1（负责人 11-22 幸运五行改成跟着当天日支变，不再同方案页）', () => {
    const f = fortuneOf(B(1992, 6, 12), '2026-11-21');
    expect(f).not.toBeNull();
    if (!f) return;
    expect(f.stars).toBe(3);
    expect(FORTUNE_TIPS.at(f.day)?.at(f.tip)?.at(0)).toBe('身边人和你想到一块，适合一起干活。');
    expect(FORTUNE_COLORS.at(f.color >> 1)?.at(f.color & 1)?.at(0)).toBe('海军蓝');
    expect(f.num).toBe(1);
    expect((FORTUNE_ME.at(f.me)?.at(0) ?? '').length > 0).toBe(true);
    expect(f.cats).toHaveLength(FORTUNE_CATS.length);
  });

  it('幸运色、数字每天跟着当天变（负责人 11-22：1987.02.07 原来只有 5/10、燕麦色/芥末黄）：连续 30 天五行都轮到', () => {
    const cs = new Set<number>();
    const ns = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const f = fortuneOf(B(1987, 2, 7), addDays('2026-11-22' as DateStr, i));
      if (f) {
        cs.add(f.color);
        ns.add(f.num);
      }
    }
    expect(cs.size).toBe(10);
    expect(ns.size).toBe(10);
  });

  it('当天类型：同一天干是第 0 类，十类覆盖全；日主和当天同干每 10 天一次', () => {
    expect(dayTypeOf(0, 0)).toBe(0);
    expect(new Set(Array.from({ length: 10 }, (_, s) => dayTypeOf(4, s))).size).toBe(10);
    expect(FORTUNE_DAY_NAMES).toHaveLength(10);
    expect(FORTUNE_TIPS).toHaveLength(10);
  });

  it('随机 300 个生日 × 40 天：星级和分项都在 2～5，颜色 0～9，数字是那一行的两个之一；同输入同输出', () => {
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const HOURS = [null, 23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
    for (let i = 0; i < 300; i++) {
      const b = B(1901 + next(126), 1 + next(12), 1 + next(28), HOURS.at(next(HOURS.length)) ?? null);
      const start = addDays('2026-01-01', next(300));
      for (let k = 0; k < 40; k++) {
        const date = addDays(start, k);
        const f = fortuneOf(b, date);
        expect(f).not.toBeNull();
        if (!f) continue;
        expect(f.stars >= 2).toBe(true);
        expect(f.stars <= 5).toBe(true);
        for (const c of f.cats) {
          expect(c.stars >= 2).toBe(true);
          expect(c.stars <= 5).toBe(true);
        }
        expect(f.color >= 0).toBe(true);
        expect(f.color <= 9).toBe(true);
        expect(f.tip).toBeLessThan(FORTUNE_TIPS.at(f.day)?.length ?? 0);
        expect(f.pillars).toHaveLength(b.h === null ? 3 : 4);
        if (k === 0) expect(fortuneOf(b, date)).toEqual(f);
      }
    }
  });

  it('第一行文案不连着重复：同一个人同一类日子相邻两次出现（隔 10 天）的那句不一样', () => {
    const b = B(1992, 6, 12);
    let date: DateStr = '2026-01-01';
    for (let i = 0; i < 200; i++, date = addDays(date, 1)) {
      const a = fortuneOf(b, date);
      const c = fortuneOf(b, addDays(date, 10));
      expect(a?.day).toBe(c?.day);
      expect(a?.tip).not.toBe(c?.tip);
    }
  });

  it('tipIndex：两句的一类轮流；三到五句的一类每轮都取全、轮与轮交界不重复', () => {
    expect([0, 1, 2, 3].map((k) => tipIndex('甲子', 1, k, 2))).toEqual(
      [0, 1, 2, 3].map((k) => (k + tipIndex('甲子', 1, 0, 2)) % 2),
    );
    expect(tipIndex('甲子', 1, 5, 1)).toBe(0);
    for (const n of [3, 4, 5]) {
      const seq = Array.from({ length: 60 }, (_, k) => tipIndex('壬申丙午己未', 3, k, n));
      for (let k = 1; k < seq.length; k++) expect(seq.at(k)).not.toBe(seq.at(k - 1));
      for (let r = 0; r < 60 / n; r++) expect(new Set(seq.slice(r * n, r * n + n)).size).toBe(n);
    }
  });
});
