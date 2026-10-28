// shared/i18n（架构 2.4）：中韩词典键一致、占位符一致；t() 填参数；fmt 不依赖 Intl 的本地化输出
import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDay, fmtTime, weekdayName } from '../../shared/i18n/fmt.ts';
import { createT, fill, placeholdersOf, t } from '../../shared/i18n/i18n.ts';
import { ko } from '../../shared/i18n/ko.ts';
import { zh } from '../../shared/i18n/zh.ts';

describe('词典', () => {
  it('中韩两边的键完全一致', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(zh).sort());
  });

  it('每个词条两边的占位符一致', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholdersOf(ko[key]), key).toEqual(placeholdersOf(zh[key]));
    }
  });

  it('没有空词条', () => {
    for (const v of [...Object.values(zh), ...Object.values(ko)]) expect(v.trim().length).toBeGreaterThan(0);
  });
});

describe('t()', () => {
  it('按语言取词条并填参数', () => {
    expect(t('remind.push.event', { time: '09:00', title: 'A' }, 'zh-CN')).toBe('09:00 A');
    expect(t('common.ok', {}, 'ko-KR')).toBe(ko['common.ok']);
    expect(t('common.ok', {}, 'zh-CN')).toBe(zh['common.ok']);
  });

  it('fill：参数里没有的占位符原样留着', () => {
    expect(fill('{a}-{b}', { a: 1 })).toBe('1-{b}');
  });

  it('createT：韩文缺键（运行时拼出来的）退回中文', () => {
    const tt = createT({ zh: { x: 'X' } as const, ko: {} as Readonly<Record<'x', string>> });
    expect(tt('x', {}, 'ko-KR')).toBe('X');
  });
});

describe('fmt', () => {
  it('weekdayName', () => {
    expect(weekdayName(0, 'zh-CN')).toBe(zh['fmt.wd.0']);
    expect(weekdayName(7, 'ko-KR')).toBe(ko['fmt.wd.0']);
    expect(weekdayName(-1, 'ko-KR')).toBe(ko['fmt.wd.6']);
  });

  it('fmtDay：模板来自词典', () => {
    expect(fmtDay('2026-10-25', 'zh-CN', 'monthDayWeek')).toBe(fill(zh['fmt.monthDayWeek'], { m: 10, d: 25, w: zh['fmt.wd.0'] }));
    expect(fmtDay('2026-10-25', 'ko-KR', 'monthDayWeek')).toBe(fill(ko['fmt.monthDayWeek'], { m: 10, d: 25, w: ko['fmt.wd.0'] }));
    expect(fmtDay('2026-01-05', 'zh-CN', 'monthDay')).toBe(fill(zh['fmt.monthDay'], { m: 1, d: 5 }));
  });

  it('fmtTime / fmtDate 按传入的时区', () => {
    const ms = Date.UTC(2026, 9, 27, 15, 5); // 首尔 10-28 00:05，洛杉矶 10-27 08:05
    expect(fmtTime(ms, 'Asia/Seoul')).toBe('00:05');
    expect(fmtTime(ms, 'America/Los_Angeles')).toBe('08:05');
    expect(fmtDate(ms, 'Asia/Seoul', 'zh-CN', 'monthDay')).toBe(fill(zh['fmt.monthDay'], { m: 10, d: 28 }));
    expect(fmtDate(ms, 'America/Los_Angeles', 'zh-CN', 'monthDay')).toBe(fill(zh['fmt.monthDay'], { m: 10, d: 27 }));
    expect(fmtDate(ms, 'Asia/Seoul', 'ko-KR', 'time')).toBe('00:05');
  });
});
