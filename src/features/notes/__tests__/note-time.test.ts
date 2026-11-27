// noteAtText：列表行（自己排时）和编辑页抽屉顶行共用的“今天 11:40 / 昨天 21:15 / 10月21日”，输出和合一前两处的原写法逐条一样
// noteDayText：组名、导入弹窗、卡片底行共用的“今天 / 昨天 / 11月13日（或 11/13）”，输出和收进来之前 NotesPage.tsx dayWord 的原写法逐条一样
import { describe, expect, it } from 'vitest';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { createT, type Locale } from '../../../../shared/i18n/i18n.ts';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { dayKind, whenOf } from '../data/note-list.ts';
import { noteAtText, noteDayText } from '../ui/note-time.ts';

const tr = createT({ zh, ko });
const tOf = (locale: Locale) => ((key: keyof typeof zh & string, params: never) => tr(key, params, locale)) as Parameters<typeof noteAtText>[0];

type Kind = 'today' | 'yesterday' | 'day';
const KINDS: readonly Kind[] = ['today', 'yesterday', 'day'];
const LOCALES: readonly Locale[] = ['zh-CN', 'ko-KR'];
const DATES: readonly DateStr[] = ['2026-11-21', '2026-01-05', '2025-12-31'] as DateStr[];

describe('noteAtText', () => {
  it('今天、昨天带时刻，再早只写日期', () => {
    const t = tOf('zh-CN');
    expect(noteAtText(t, 'zh-CN', { kind: 'today', hm: '11:40', date: '2026-11-21' as DateStr })).toBe('今天 11:40');
    expect(noteAtText(t, 'zh-CN', { kind: 'yesterday', hm: '21:15', date: '2026-11-20' as DateStr })).toBe('昨天 21:15');
    expect(noteAtText(t, 'zh-CN', { kind: 'day', hm: '08:00', date: '2026-10-21' as DateStr })).toBe(fmtDay('2026-10-21' as DateStr, 'zh-CN', 'monthDay'));
    expect(noteAtText(tOf('ko-KR'), 'ko-KR', { kind: 'today', hm: '11:40', date: '2026-11-21' as DateStr })).toBe('오늘 11:40');
  });

  it('和合一前列表行 rowTime、编辑页 when 的原写法逐条一样', () => {
    for (const locale of LOCALES) {
      const t = tOf(locale);
      for (const kind of KINDS) {
        for (const date of DATES) {
          const hm = '09:05';
          // NotesPage.tsx rowTime 原写法（自己排时）
          const row = kind === 'today' ? t('notes.at.today', { t: hm }) : kind === 'yesterday' ? t('notes.at.yesterday', { t: hm }) : fmtDay(date, locale, 'monthDay');
          // NoteEditPage.tsx when 原写法
          const edit = kind === 'day' ? fmtDay(date, locale, 'monthDay') : t(kind === 'today' ? 'notes.at.today' : 'notes.at.yesterday', { t: hm });
          const got = noteAtText(t, locale, { kind, hm, date });
          expect(got).toBe(row);
          expect(got).toBe(edit);
        }
      }
    }
  });
});

describe('noteDayText', () => {
  it('和收进来之前 NotesPage.tsx dayWord 的原写法逐条一样（组名、导入弹窗 monthDay，卡片底行 num）', () => {
    for (const locale of LOCALES) {
      const t = tOf(locale);
      for (const kind of KINDS) {
        for (const date of DATES) {
          for (const style of ['monthDay', 'num'] as const) {
            const old = kind === 'today' ? t('notes.g.today', {}) : kind === 'yesterday' ? t('notes.g.yesterday', {}) : fmtDay(date, locale, style);
            expect(noteDayText(t, locale, kind, date, style)).toBe(old);
          }
        }
      }
    }
  });
});

describe('whenOf', () => {
  it('和收进来之前 useNoteEdit.ts when 的原写法一样（今天、昨天、更早，首尔时区）', () => {
    const tz = 'Asia/Seoul' as Tz;
    const now = Date.UTC(2026, 10, 21, 3, 0);
    for (const at of [now - 60_000, now - 86_400_000, now - 30 * 86_400_000, Date.UTC(2026, 10, 20, 15, 30)]) {
      expect(whenOf(at, now, tz)).toEqual({ kind: dayKind(at, now, tz), hm: fmtTime(at, tz), date: todayOf(at, tz) });
    }
    expect(whenOf(now - 86_400_000, now, tz).kind).toBe('yesterday');
  });
});
