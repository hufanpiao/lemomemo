// 查找面板的小零件：命中词高亮、每行第二行文字、一行结果的主体（HitBody）、电脑右栏预览、文案 hook。
// FindPanel.tsx、PullSearch.tsx（下拉搜索）共用。行首记号、打开一条、日子文字在 kit RecordMark.tsx（和 AI 助手共用）
import type { ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { Marked as KitMarked } from '../../../kit/components/Marked.tsx';
import { openRecord, RecordMark } from '../../../kit/components/RecordMark.tsx';
import type { FindHit, FindItem } from '../hooks/useFind.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import styles from './FindPanel.module.css';

export const useFindT = makeUseT({ zh, ko });

/** 打开一条（查找面板、结果层、下拉搜索共用；怎么打开在 kit RecordMark.tsx 的 openRecord，和 AI 助手同一份） */
export const openItem = (it: FindItem): void => openRecord(it.kind, it.id, it.noteId);
export type T = ReturnType<typeof useFindT>;

/** 文字里命中的词标成黑底白字（kit 的 Marked，下拉搜索同一份、只换样子：hl 传 kit PullSlot 的短下划线） */
export function Marked({ text, q, hl = styles.hl }: { text: string; q: string; hl?: string | undefined }): ReactNode {
  return <KitMarked text={text} q={q} className={hl} />;
}

/** 一行结果的主体：行首记号、标题、第二行（查找面板、下拉搜索的行按钮里都是这一份） */
export function HitBody({ h, q, t, locale, hl }: { h: FindHit; q: string; t: T; locale: 'zh-CN' | 'ko-KR'; hl?: string | undefined }) {
  return (
    <>
      <RecordMark kind={h.item.kind} done={h.item.done} />
      <span className={styles.text}>
        <span className={styles.title}><Marked text={h.item.title || t('find.noTitle', {})} q={q} hl={hl} /></span>
        <span className={styles.meta}><Marked text={metaOf(h, t, locale)} q={q} hl={hl} /></span>
      </span>
    </>
  );
}

/** 行按钮的 data-done：只有做完了的待办带（标题灰色加删除线，FindPanel.module.css 的 .row[data-done]） */
export const doneAttr = (it: FindItem): true | undefined => (it.kind === 'todo' && it.done) || undefined;

/** 日子（已格式化、带星期）和时刻，没有的部分不写；第二行和右栏预览共用（日子没格式化的用 kit RecordMark.tsx 的 whenText） */
const dayTime = (day: string, time: string | null | undefined): string => [day, time ?? ''].filter(Boolean).join(' ');

/** 第二行：日程“日子 时刻 · 地点”、待办“日子截止 · 项目”、纪念日“下一次 日子”、随手记和文档有片段给片段、图片和文档写在哪条随手记里 */
export function metaOf(h: FindHit, t: T, locale: 'zh-CN' | 'ko-KR'): string {
  const it = h.item;
  const day = it.date ? fmtDay(it.date, locale, 'monthDayWeek') : '';
  const join = (...xs: string[]) => xs.filter((x) => x !== '').join(' · ');
  switch (it.kind) {
    case 'event': return join(dayTime(day, it.time), it.extra);
    case 'todo': return join(it.done ? t('find.todo.done', {}) : it.date ? t('find.todo.due', { d: day }) : t('find.todo.noDue', {}), it.extra);
    case 'anniv': return it.date ? t('find.anniv.next', { d: day }) : '';
    case 'note': return h.snippet ? `“${h.snippet}”` : day;
    case 'file': return join(h.snippet ? `“${h.snippet}”` : '', t('find.inNote', { t: it.extra || t('find.noTitle', {}) }));
    case 'image': return t('find.inNote', { t: it.extra || t('find.noTitle', {}) });
  }
}

/** 电脑右栏：选中的一条的预览（类型 · 预览、标题、时间 / 地点 / 备注；图片的 AI 描述和标签） */
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
      {kv(t('find.desk.time', {}), dayTime(day, it.time))}
      {it.kind === 'event' ? kv(t('find.desk.place', {}), it.extra) : null}
      {kv(t('find.desk.note', {}), note)}
      {body !== '' ? <div className={styles.pv}><Marked text={body} q={q} /></div> : null}
      {it.kind === 'file' || it.kind === 'image' ? <p className={styles.pk}>{t('find.inNote', { t: it.extra || t('find.noTitle', {}) })}</p> : null}
    </div>
  );
}
