// 查找面板的小零件（B4b-2；线框 s12、sFind）：命中词高亮、行首记号、每行第二行文字、电脑右栏预览、文案 hook。FindPanel.tsx 用
import type { ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { markRanges, type FindHit, type FindKind } from '../hooks/useFind.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import styles from './FindPanel.module.css';

export const useFindT = makeUseT({ zh, ko });
export type T = ReturnType<typeof useFindT>;

/** 文字里命中的词标成黑底白字 */
export function Marked({ text, q }: { text: string; q: string }): ReactNode {
  const rs = markRanges(text, q);
  if (rs.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of rs) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a} className={styles.hl}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Lead({ kind }: { kind: FindKind }) {
  const mark = { event: styles.bar, todo: styles.ring, anniv: styles.dia, image: styles.pic, note: styles.doc, file: styles.doc }[kind];
  return (
    <span className={styles.lead} aria-hidden="true">
      <span className={mark}>{kind === 'note' ? '≡' : kind === 'file' ? 'DOC' : null}</span>
    </span>
  );
}

/** 第二行：日程“日子 时刻 · 地点”、待办“日子截止 · 项目”、纪念日“下一次 日子”、随手记和文档有片段给片段、图片和文档写在哪条随手记里 */
export function metaOf(h: FindHit, t: T, locale: 'zh-CN' | 'ko-KR'): string {
  const it = h.item;
  const day = it.date ? fmtDay(it.date, locale, 'monthDayWeek') : '';
  const join = (...xs: string[]) => xs.filter((x) => x !== '').join(' · ');
  switch (it.kind) {
    case 'event': return join([day, it.time ?? ''].filter(Boolean).join(' '), it.extra);
    case 'todo': return join(it.done ? t('find.todo.done', {}) : it.date ? t('find.todo.due', { d: day }) : t('find.todo.noDue', {}), it.extra);
    case 'anniv': return it.date ? t('find.anniv.next', { d: day }) : '';
    case 'note': return h.snippet ? `“${h.snippet}”` : day;
    case 'file': return join(h.snippet ? `“${h.snippet}”` : '', t('find.inNote', { t: it.extra || t('find.noTitle', {}) }));
    case 'image': return t('find.inNote', { t: it.extra || t('find.noTitle', {}) });
  }
}

/** 电脑右栏：选中的一条的预览（线框 s12 电脑版：类型 · 预览、标题、时间 / 地点 / 备注；sFind 电脑版：图片的 AI 描述和标签） */
export function Preview({ h, q, t, locale }: { h: FindHit; q: string; t: T; locale: 'zh-CN' | 'ko-KR' }) {
  const it = h.item;
  const day = it.date ? fmtDay(it.date, locale, 'monthDayWeek') : '';
  const kv = (label: string, v: string): ReactNode => (v === '' ? null : (
    <>
      <div className={styles.pl}>{label}</div>
      <div className={styles.pv}><Marked text={v} q={q} /></div>
    </>
  ));
  const note = it.kind === 'event' ? it.fields[2] ?? '' : it.kind === 'todo' || it.kind === 'anniv' ? it.fields[1] ?? '' : '';
  const body = it.kind === 'note' || it.kind === 'file' ? (h.snippet ?? (it.fields[1] ?? '').slice(0, 300)) : it.kind === 'image' ? it.fields[1] ?? '' : '';
  return (
    <div data-testid="find-preview-item">
      <div className={styles.pk}>{t('find.desk.preview', { k: t(`find.k.${it.kind}`, {}) })}</div>
      <div className={styles.ptitle}><Marked text={it.title || t('find.noTitle', {})} q={q} /></div>
      {kv(t('find.desk.time', {}), [day, it.time ?? ''].filter(Boolean).join(' '))}
      {it.kind === 'event' ? kv(t('find.desk.place', {}), it.extra) : null}
      {kv(t('find.desk.note', {}), note)}
      {body !== '' ? <div className={styles.pv}><Marked text={body} q={q} /></div> : null}
      {it.kind === 'file' || it.kind === 'image' ? <p className={styles.pk}>{t('find.inNote', { t: it.extra || t('find.noTitle', {}) })}</p> : null}
    </div>
  );
}
