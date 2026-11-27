// AI 助手的小零件：词典、依据行第二行的文字、日程竖条的项目色。
// 行首记号、打开原条目、日子文字用 kit RecordMark.tsx（和查找面板共用）
import { useMemo } from 'react';
import { diffDays } from '../../../../shared/core/date.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import type { ChatKind, ChatRef } from '../../../../shared/schema/chat.ts';
import { whenText, type MarkLocale } from '../../../kit/components/RecordMark.tsx';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export const useChatT = makeUseT({ zh, ko });
export type T = ReturnType<typeof useChatT>;
export type Locale = MarkLocale;

/** 第二行：待办“今天 18:00 截止”“逾 2 天”“已完成”；日程“11月25日 周三 14:00”；随手记、纪念日写日子（今天写“今天”）。late：逾期（标红） */
export function refMeta(r: ChatRef, today: string, t: T, locale: Locale): { text: string; late: boolean } {
  const td = { day: today, label: t('chat.day.today', {}) };
  if (r.kind === 'todo') {
    if (r.done === true) return { text: t('chat.done', {}), late: false };
    if (r.date === null) return { text: '', late: false };
    if (r.date < today) return { text: t('chat.late', { n: diffDays(r.date, today) }), late: true };
    const d = whenText(r.date, null, locale, td);
    return { text: r.time ? t('chat.dueAt', { d, t: r.time }) : t('chat.due', { d }), late: false };
  }
  return { text: whenText(r.date, r.kind === 'event' ? r.time : null, locale, td), late: false };
}

export const kindName = (k: ChatKind | 'web', t: T): string => t(`chat.k.${k}`, {});

/** 二级域名在这些里的（go.kr、co.kr、com.cn……）再往前取一段，才是网站自己的名字 */
const SLD = new Set(['co', 'go', 'or', 'ac', 'ne', 're', 'com', 'net', 'org', 'gov', 'edu']);

/**
 * 网页来源行首的字母（参考 .fav：weather.naver.com → N、www.kma.go.kr → K）：去掉 www，取网站自己那一段的第一个字母、大写；
 * 认不出网站名的用标题第一个字
 */
export function favLetter(site: string, title: string): string {
  const parts = site.toLowerCase().replace(/^www\./, '').split('.').filter((p) => p !== '');
  let name = parts.length >= 2 ? parts[parts.length - 2] ?? '' : parts[0] ?? '';
  if (parts.length >= 3 && SLD.has(name)) name = parts[parts.length - 3] ?? name;
  const ch = [...(name || title.trim())][0] ?? '·';
  return ch.toUpperCase();
}

/**
 * 回答上面那行灰字（参考 .lbl）：联网了写“联网查了 N 个网页”，再接“· 用了你的 1 条日程”（按正文引到的记录逐类数）；
 * 没联网写“查了你的日程、待办 · 找到 N 条”；都没有回空串（不画）
 */
export function lblOf(a: { searched: readonly ChatKind[]; found: number; webs: number; refs: readonly { kind: ChatKind | 'web' }[] }, t: T): string {
  if (a.webs > 0) {
    const used = new Map<ChatKind, number>();
    for (const r of a.refs) if (r.kind !== 'web') used.set(r.kind, (used.get(r.kind) ?? 0) + 1);
    const items = [...used].map(([k, n]) => t('chat.item', { n, kind: kindName(k, t) })).join(t('chat.and', {}));
    return [t('chat.lblWeb', { n: a.webs }), ...(items === '' ? [] : [t('chat.lblUsed', { items })])].join(' · ');
  }
  if (a.searched.length === 0) return '';
  return t('chat.lbl', { kinds: a.searched.map((k) => kindName(k, t)).join(t('chat.and', {})), n: a.found });
}

/** 日程竖条的颜色：项目色（同列表、日历的 projectColorIndex；参考 .calbar 用 --pNs），没有项目用 --text-2（同提醒页 .pc0） */
export const calbarColor = (project: string | undefined): string => {
  const i = projectColorIndex(project ?? '');
  return i === 0 ? 'var(--text-2)' : `var(--p${i}s)`;
};

/** 日程 id → 项目名：从本机库的 events 查（服务器不读 events.project）；本机没有这条的按没有项目 */
export function useEventProjects(): (id: string) => string | undefined {
  const events = useCollection<{ id: string; project?: unknown }>('events');
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (typeof e.project === 'string') m.set(e.id, e.project);
    return (id: string) => m.get(id);
  }, [events]);
}
