// noteAtText：列表行（自己排时）和编辑页抽屉顶行共用的“今天 11:40 / 昨天 21:15 / 10月21日”，输出和合一前两处的原写法逐条一样
import { describe, expect, it } from 'vitest';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { createT, type Locale } from '../../../../shared/i18n/i18n.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { noteAtText } from '../ui/note-time.ts';

const tr = createT({ zh, ko });
const tOf = (locale: Locale) => ((key: keyof typeof zh & string, params: never) => tr(key, params, locale)) as Parameters<typeof noteAtText>[0];

type Kind = 'today' | 'yesterday' | 'day';
const KINDS: readonly Kind[] = ['today', 'yesterday', 'day'];
const LOCALES: readonly Locale[] = ['zh-CN', 'ko-KR'];
const DATES: readonly DateStr[] = ['2026-11-21', '2026-01-05', '2025-12-31'] as DateStr[];

describe('noteAtText', () => {
  it('今天、昨天带时刻，再早只写日期', () => {
    const t = tOf('zh-CN');
    expect(noteAtText(t, 'zh-CN', 'today', '11:40', '2026-11-21' as DateStr)).toBe('今天 11:40');
    expect(noteAtText(t, 'zh-CN', 'yesterday', '21:15', '2026-11-20' as DateStr)).toBe('昨天 21:15');
    expect(noteAtText(t, 'zh-CN', 'day', '08:00', '2026-10-21' as DateStr)).toBe(fmtDay('2026-10-21' as DateStr, 'zh-CN', 'monthDay'));
    expect(noteAtText(tOf('ko-KR'), 'ko-KR', 'today', '11:40', '2026-11-21' as DateStr)).toBe('오늘 11:40');
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
          const got = noteAtText(t, locale, kind, hm, date);
          expect(got).toBe(row);
          expect(got).toBe(edit);
        }
      }
    }
  });
});
