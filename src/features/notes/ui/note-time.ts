// 随手记“今天 / 昨天 / 日期”怎么写，只有这一份：
// • noteDayText：只写哪天——今天 / 昨天写字，再早按 style 写日期（分组名、导入弹窗“11月13日”，卡片底行“11/13”）
// • noteAtText：带时刻——今天 → “今天 11:40”、昨天 → “昨天 21:15”、再早 → 只写日期“10月21日”（不带时刻）；列表行（自己排时）、编辑页抽屉顶行用
// 哪一种天、时刻、那天由 data/note-list.ts 的 dayKind / whenOf 算（界面层不直接引数据层：列表经 useNoteList 的 dayOf，编辑页经 useNoteEdit 的 when）
import { fmtDay, type DayStyle } from '../../../../shared/i18n/fmt.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import type { NoteWhen } from '../hooks/useNoteEdit.ts';
import type { useNotesT } from '../hooks/useNotesT.ts';

type NotesT = ReturnType<typeof useNotesT>;

export function noteDayText(t: NotesT, locale: Locale, kind: NoteWhen['kind'], date: DateStr, style: DayStyle): string {
  if (kind === 'today') return t('notes.g.today', {});
  if (kind === 'yesterday') return t('notes.g.yesterday', {});
  return fmtDay(date, locale, style);
}

export function noteAtText(t: NotesT, locale: Locale, w: NoteWhen): string {
  if (w.kind === 'today') return t('notes.at.today', { t: w.hm });
  if (w.kind === 'yesterday') return t('notes.at.yesterday', { t: w.hm });
  return noteDayText(t, locale, w.kind, w.date, 'monthDay');
}
