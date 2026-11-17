// 下拉搜索的本机筛选（R-437）：随手记、待办、日历页标题下面那一条搜索框，就地筛本页的记录
// • 条目、命中规则、排序、高亮、片段全部沿用查找面板那一套（./find-local.ts 的 buildIndex、findLocal，命中规则在 shared/logic/search.ts），这里只改“查哪几个字段”：
//   随手记：标题、正文、分类名（R-437 原话“按标题、正文、分类筛”；分类名按 core 的 categoryNameOf 归到合并后留下的那个）；
//   待办：标题、子任务（todo_items 里还活着的）；日程：只看标题
// • 隐私记不搜：buildIndex 本来就不收 is_private 的随手记（D-16）；删了、撤销的不出
// • 只出命中了哪几条（页面就地筛）；待办靠子任务命中的也算，不另给片段（R-447 起待办页不再列结果行，片段没人画）
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { str } from '../../../../shared/logic/notes/note-headline.ts';
import { categoryNameOf } from '../../../core/categories.ts';
import { buildIndex, type FindItem, type Row } from './find-local.ts';

export type PullScope = 'note' | 'todo' | 'event';

/** 每页要的集合：本页的主表 + 一张附表（随手记要分类，待办要子任务，日程不用） */
export const PULL_TABLES: Record<PullScope, readonly [string, string | null]> = {
  note: ['notes', 'categories'],
  todo: ['todos', 'todo_items'],
  event: ['events', null],
};

/** 结果最多列多少条（多的提示换个更准的词） */
export const PULL_MAX = 50;

const none: readonly Row[] = [];

/** 本页的记录 → 可查的条目（字段按页换，见文件头） */
export function pullIndex(scope: PullScope, rows: readonly Row[], extra: readonly Row[], tz: Tz): FindItem[] {
  const base = { events: none, todos: none, anniversaries: none, notes: none, note_images: none, note_files: none };
  if (scope === 'event') return buildIndex({ ...base, events: rows }, tz).map((it) => ({ ...it, fields: [it.title] }));
  if (scope === 'todo') {
    const subs = new Map<string, string[]>();
    for (const r of extra) {
      const id = str(r['todo_id']);
      if (!isLiveRow(r) || id === '') continue;
      const xs = subs.get(id) ?? [];
      xs.push(str(r['title']));
      subs.set(id, xs);
    }
    return buildIndex({ ...base, todos: rows }, tz).map((it) => ({ ...it, fields: [it.title, ...(subs.get(it.id) ?? [])] }));
  }
  const nameOf = categoryNameOf(extra);
  const cat = new Map(rows.map((r) => [r.id, nameOf(r['category_id']) ?? '']));
  return buildIndex({ ...base, notes: rows }, tz).map((it) => ({ ...it, fields: [it.title, it.fields[1] ?? '', cat.get(it.id) ?? ''] }));
}
