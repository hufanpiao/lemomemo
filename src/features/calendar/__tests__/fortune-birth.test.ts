// data/fortune-birth.ts：settings 键 cal.fortune_birth 的值校验（只在前端，不加迁移）和小键盘打年份（方案页丙“打两位就够”）
import { describe, expect, it } from 'vitest';
import { BIRTH_HOURS, afterToday, hourOk, parseBirth, typedYear } from '../data/fortune-birth.ts';

describe('parseBirth', () => {
  it('合格的原样回；没有 h 当作不知道几点', () => {
    expect(parseBirth({ y: 1992, m: 6, d: 12, h: 9 }, '2026-11-21')).toEqual({ y: 1992, m: 6, d: 12, h: 9 });
    expect(parseBirth({ y: 2024, m: 2, d: 29 }, '2026-11-21')).toEqual({ y: 2024, m: 2, d: 29, h: null });
    expect(parseBirth({ y: 1901, m: 1, d: 1, h: 23 }, '2026-11-21')).not.toBeNull();
  });
  it('不合格回 null：年份 1901～今年以外、晚于今天（2026-11-22、12-01）、月 1～12 以外、日超出那个月、时段不是 null 或 23、1～21 的奇数、不是整数、不是对象', () => {
    for (const v of [
      { y: 1900, m: 1, d: 1, h: null },
      { y: 2027, m: 1, d: 1, h: null },
      { y: 1992, m: 13, d: 1, h: null },
      { y: 1992, m: 0, d: 1, h: null },
      { y: 2023, m: 2, d: 29, h: null },
      { y: 1992, m: 4, d: 31, h: null },
      { y: 1992, m: 6, d: 12, h: 2 },
      { y: 1992, m: 6, d: 12, h: 0 },
      { y: 1992, m: 6, d: 12, h: 25 },
      { y: 2026, m: 11, d: 22, h: null },
      { y: 2026, m: 12, d: 1, h: null },
      { y: 1992.5, m: 6, d: 12, h: null },
      { y: '1992', m: 6, d: 12, h: null },
      {},
      null,
      '1992-06-12',
    ]) {
      expect(parseBirth(v, '2026-11-21')).toBeNull();
    }
  });
  it('今天当天可以，明天不行', () => {
    expect(parseBirth({ y: 2026, m: 11, d: 21, h: null }, '2026-11-21')).not.toBeNull();
    expect(afterToday(2026, 11, 21, '2026-11-21')).toBe(false);
    expect(afterToday(2026, 11, 22, '2026-11-21')).toBe(true);
  });
  it('时段表：不知道 + 12 段，全部合格', () => {
    expect(BIRTH_HOURS).toHaveLength(13);
    expect(BIRTH_HOURS.every(hourOk)).toBe(true);
  });
});

describe('typedYear', () => {
  it('两位：今年后两位以内算 20xx，以上算 19xx；19、20 等后两位', () => {
    expect(typedYear('92', 2026)).toEqual({ typed: '1992', year: 1992 });
    expect(typedYear('26', 2026)).toEqual({ typed: '2026', year: 2026 });
    expect(typedYear('27', 2026)).toEqual({ typed: '1927', year: 1927 });
    expect(typedYear('05', 2026)).toEqual({ typed: '2005', year: 2005 });
    expect(typedYear('19', 2026)).toEqual({ typed: '19', year: null });
    expect(typedYear('20', 2026)).toEqual({ typed: '20', year: null });
    expect(typedYear('1', 2026)).toEqual({ typed: '1', year: null });
    expect(typedYear('', 2026)).toEqual({ typed: '', year: null });
  });
  it('四位：1901～今年才算定了', () => {
    expect(typedYear('1988', 2026)).toEqual({ typed: '1988', year: 1988 });
    expect(typedYear('2099', 2026)).toEqual({ typed: '2099', year: null });
    expect(typedYear('1900', 2026)).toEqual({ typed: '1900', year: null });
    expect(typedYear('199', 2026)).toEqual({ typed: '199', year: null });
  });
});
