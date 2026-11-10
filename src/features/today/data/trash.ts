// “最近删除”页的列表（B2 FA-2；ADR-006；TC-B2-03 前两步；B4 S2 加随手记）：从 today-actions.ts 拆出来（B4 首屏额度：
// today-actions.ts 跟着今天页进首屏，这份只有“最近删除”页用，单独一个文件就跟着那一页的分包走）
// • deleted_at 不为空、undone 不为 true、删了不到 30 天的日程、待办和随手记（隐私记不在这里，R-193），最近删的在前
// 纯 TS：不准 import React（A1）
import type { Row } from './today-model.ts';
import type { TrashTable } from './today-actions.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrashItem {
  table: TrashTable;
  id: string;
  title: string;
  deletedAt: number;
  /** 再过多少天清理（向上取整，至少 1） */
  daysLeft: number;
}

/** 随手记在“最近删除”里的标题：有标题用标题，没有取正文第一行（同随手记页） */
function noteTitle(r: Row): string {
  const t = str(r['title'])?.trim() ?? '';
  if (t !== '') return t;
  return (str(r['body']) ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/** “最近删除”的列表（随手记只列普通的，隐私记不在这里） */
export function trashOf(events: readonly Row[], todos: readonly Row[], now: number, notes: readonly Row[] = []): TrashItem[] {
  const out: TrashItem[] = [];
  const add = (table: TrashTable, rows: readonly Row[]) => {
    for (const r of rows) {
      const at = r['deleted_at'];
      if (typeof at !== 'number' || r['undone'] === true || r['is_private'] === true) continue;
      const left = at + TRASH_KEEP_MS - now;
      if (left <= 0) continue;
      const title = table === 'notes' ? noteTitle(r) : typeof r['title'] === 'string' ? r['title'] : '';
      out.push({ table, id: r.id, title, deletedAt: at, daysLeft: Math.max(1, Math.ceil(left / 86_400_000)) });
    }
  };
  add('events', events);
  add('todos', todos);
  add('notes', notes);
  return out.sort((a, b) => b.deletedAt - a.deletedAt || a.title.localeCompare(b.title));
}
