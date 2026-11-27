// 一条记录的行首记号、打开它、日子文字（查找和 AI 助手共用这一份，不各写一份）
// • RecordMark：日程竖条、待办方框（做完的实心打勾）、随手记文档、纪念日菱形、图片方块；size sm（查找面板、结果层、下拉搜索）/ md（AI 助手依据列表），
//   两种尺寸的样子见 RecordMark.module.css 文件头；color 只给日程竖条（AI 助手按项目色上色）
// • openRecord：日程、待办、纪念日进各自的编辑页；随手记、图片、文档进所在随手记
// • whenText：“11月10日 周二 15:00”，没有的部分不写；给了 today 的，那一天写成 today.label（AI 助手写“今天”）
import { fmtDay } from '../../../shared/i18n/fmt.ts';
import { navigate } from '../../app/router.ts';
import check from './CheckCircle.module.css';
import s from './RecordMark.module.css';

export type MarkKind = 'event' | 'todo' | 'note' | 'anniv' | 'image' | 'file';
export type MarkLocale = 'zh-CN' | 'ko-KR';

export function RecordMark({ kind, done = false, size = 'sm', color }: { kind: MarkKind; done?: boolean | undefined; size?: 'sm' | 'md'; color?: string | undefined }) {
  const md = size === 'md';
  if (kind === 'todo' && done && !md) {
    return (
      <span className={s.lead} aria-hidden="true" data-testid="lead-done">
        <span className={s.ringDone}>
          <span className={check.fill} data-state="on" />
          <span className={check.tick} data-state="on" />
        </span>
      </span>
    );
  }
  const mark = {
    event: s.bar,
    todo: done ? s.boxDone : s.ring,
    anniv: s.dia,
    image: s.pic,
    note: md ? s.doci : s.doc,
    file: s.doc,
  }[kind];
  const glyph = md ? null : kind === 'note' ? '≡' : kind === 'file' ? 'DOC' : null;
  return (
    <span className={s.lead} aria-hidden="true" data-size={size}>
      <span className={mark} style={kind === 'event' && color ? { background: color } : undefined}>{glyph}</span>
    </span>
  );
}

export function openRecord(kind: MarkKind, id: string, noteId?: string | null): void {
  if (kind === 'event' || kind === 'todo' || kind === 'anniv') void navigate(kind, id);
  else void navigate('note', noteId ?? id);
}

export function whenText(date: string | null | undefined, time: string | null | undefined, locale: MarkLocale, today?: { day: string; label: string }): string {
  const day = !date ? '' : today && date === today.day ? today.label : fmtDay(date, locale, 'monthDayWeek');
  return [day, time ?? ''].filter(Boolean).join(' ');
}
