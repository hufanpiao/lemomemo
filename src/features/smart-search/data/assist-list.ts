// “＋”判成查找、总结以后列出哪些（架构 5.14 第 3、4 点；B4b-3）。纯函数：本机索引（find-local 的 buildIndex）进、条目出
// • 时间类（query.range 不为空）：只用 range、kinds、done 三个条件精确列出，query.text 不再过滤（“AI 只解析条件，不生成列表”）；
//   日程按换算到设备时区后的日子（buildIndex 已换算），待办按截止日（没有截止日的不列），随手记按创建那天；
//   range.from 为 null = 截止到 to（“今天没完成的”）。按日子、时刻排，同一天的放一组
// • 内容类（range 为空）：按 query.text 关键词找（同查找面板的关键词一路），再按 kinds、done 筛
// • kinds：event / todo / note；note 连带这条随手记里的图片、文档；没给（空）= 三种都要。纪念日不进
// • exclude：刚按记下保存的这一批的 id（模糊时“也帮你找了一下”排除自己，0.23 L3）
// • 总结要送的（refsOf）：日程、待办、随手记的 id；图片、文档换成所在随手记；去重；最多 SUMMARY_MAX_ITEMS 条
// 纯 TS：不准 import React（A1）
import type { DateStr } from '../../../../shared/core/date.ts';
import type { IntentKind } from '../../../../shared/schema/kinds.ts';
import type { PlusQuery } from '../../../../shared/schema/intent.ts';
import { SUMMARY_MAX_ITEMS, type SummaryRef } from '../../../../shared/schema/summarize.ts';
import { findLocal, type FindItem, type FindKind } from './find-local.ts';

const KIND_OF: Record<IntentKind, readonly FindKind[]> = { event: ['event'], todo: ['todo'], note: ['note', 'image', 'file'] };

const ord = (it: FindItem): string => `${it.date ?? '9999-99-99'} ${it.time ?? '99:99'}`;

/** 照 query 列出（见文件头）；结果里没有纪念日 */
export function listQuery(index: readonly FindItem[], q: PlusQuery, exclude: ReadonlySet<string> = new Set()): FindItem[] {
  const kinds = new Set((q.kinds.length > 0 ? q.kinds : (['event', 'todo', 'note'] as const)).flatMap((k) => KIND_OF[k]));
  const keep = (it: FindItem): boolean => {
    if (!kinds.has(it.kind) || exclude.has(it.id) || (it.noteId !== null && exclude.has(it.noteId))) return false;
    if (it.kind === 'todo' && q.done !== 'any' && it.done !== (q.done === 'done')) return false;
    return true;
  };
  if (q.range === null) {
    const text = q.text.trim();
    if (text === '') return [];
    return findLocal(index.filter(keep), text).map((h) => h.item);
  }
  const { from, to } = q.range;
  return index
    .filter((it) => keep(it) && it.date !== null && (from === null || it.date >= from) && it.date <= to)
    .sort((a, b) => (ord(a) < ord(b) ? -1 : ord(a) > ord(b) ? 1 : 0));
}

/** 按日子分组（时间类结果用；已经按日子排好） */
export function byDay(items: readonly FindItem[]): { date: DateStr; items: FindItem[] }[] {
  const out: { date: DateStr; items: FindItem[] }[] = [];
  for (const it of items) {
    if (it.date === null) continue;
    const last = out[out.length - 1];
    if (last && last.date === it.date) last.items.push(it);
    else out.push({ date: it.date, items: [it] });
  }
  return out;
}

/** 截止到今天的查找里过期了的（截止日早于 today、没做完） */
export const isOverdue = (it: FindItem, today: DateStr): boolean => it.kind === 'todo' && !it.done && it.date !== null && it.date < today;

/** 总结送哪几条（见文件头）；more：超过上限没送的条数 */
export function refsOf(items: readonly FindItem[]): { refs: SummaryRef[]; more: number } {
  const seen = new Set<string>();
  const all: SummaryRef[] = [];
  for (const it of items) {
    const ref: SummaryRef | null =
      it.kind === 'event' || it.kind === 'todo' || it.kind === 'note' ? { kind: it.kind, id: it.id } : it.noteId !== null ? { kind: 'note', id: it.noteId } : null;
    if (ref === null || seen.has(ref.id)) continue;
    seen.add(ref.id);
    all.push(ref);
  }
  return { refs: all.slice(0, SUMMARY_MAX_ITEMS), more: Math.max(0, all.length - SUMMARY_MAX_ITEMS) };
}
