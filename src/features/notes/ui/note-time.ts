// 一条随手记的“哪天几点”怎么写（改善报告第七节：原来列表行 NotesPage.tsx 的 rowTime、编辑页 NoteEditPage.tsx 抽屉顶行各写一份）：
// 今天 → “今天 11:40”、昨天 → “昨天 21:15”、再早 → 只写日期“10月21日”（不带时刻）
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import type { useNotesT } from '../hooks/useNotesT.ts';

type NotesT = ReturnType<typeof useNotesT>;

/** kind 是 data/note-list.ts 的 dayKind 结果（today / yesterday / day）；hm 是时刻文字，date 是那天（本机时区） */
export function noteAtText(t: NotesT, locale: Locale, kind: 'today' | 'yesterday' | 'day', hm: string, date: DateStr): string {
  if (kind === 'today') return t('notes.at.today', { t: hm });
  if (kind === 'yesterday') return t('notes.at.yesterday', { t: hm });
  return fmtDay(date, locale, 'monthDay');
}
