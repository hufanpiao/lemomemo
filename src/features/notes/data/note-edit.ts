// 随手记新建、编辑的数据逻辑（B4 S2；定稿线框 s7 底部输入行、s8 编辑器；架构 5.2 第 2839 行）
// • 表单 ↔ 行：formOf 取编辑器要的三个字段（分类经 note-list.ts 的 categoryResolver，合并掉的归到留下的那个）；newNoteRow 造新建的整行
// • 新建时先用本机规则给一个分类（classify.ts 的 ruleCategory，转调后端的 shared/logic/notes/classify-rules.ts）：分到了写 category_source = 'rule'，没分到写 'none'。
//   ai_status 不写：它是系统列，客户端无权写（架构 5.2 第 2797 行 M5、table_meta 的 system_cols），库里 insert 时默认就是 'pending'，
//   等 ai-classify 来分（任务单 S2 的“保存时写 ai_status = pending”按这个落地）
// • 改了什么就只写什么（patchOf）：比较前后两份表单，只放变了的列，外加 updated_at；
//   用户手动改分类：同一个 patch 写 category_id、category_source = 'manual'、category_seen = true（之后 AI 永远不改，S2）
// • 标题可空（库里 title 允许 null）：空标题存 null；标题和正文都空时不保存（useEditRecord 的 titleOf 为空）
// 纯 TS：不准 import React（A1）
import { collection } from '../../../core/store.ts';
import { categoryResolver, type Row } from './note-list.ts';

export interface NoteForm {
  title: string;
  body: string;
  category_id: string | null;
}

export const TITLE_MAX = 160;
export const BODY_MAX = 20000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** categories 不传时读本机集合（编辑页经 useEditRecord 只传行） */
export function formOf(row: Readonly<Record<string, unknown>>, categories: readonly Row[] = collection<Row>('categories').getSnapshot()): NoteForm {
  return { title: str(row['title']), body: str(row['body']), category_id: categoryResolver(categories)(row['category_id']) };
}

/**
 * 编辑页分类旁的“AI”还标不标：这一行是 AI 分的、归到了活着的分类，表单的分类还是它（两边都按 formOf 归并后比，和列表的 showsAi 一致；
 * 用户手动改了分类就不标）
 */
export function aiMarkKept(row: Readonly<Record<string, unknown>>, form: NoteForm, categories?: readonly Row[]): boolean {
  const cid = formOf(row, categories).category_id;
  return row['category_source'] === 'ai' && cid !== null && cid === form.category_id;
}

export function emptyForm(): NoteForm {
  return { title: '', body: '', category_id: null };
}

/** 有没有可存的内容（标题或正文有一个不是空白） */
export function contentOf(f: NoteForm): string {
  return `${f.title}${f.body}`.trim();
}

const titleCol = (t: string): string | null => (t.trim() === '' ? null : t.trim());

/** 新建的整行；category = 本机规则分到的分类（没分到为 null） */
export function newNoteRow(id: string, f: NoteForm, now: number, category: string | null = f.category_id): Record<string, unknown> & { id: string } {
  return {
    id,
    title: titleCol(f.title),
    body: f.body,
    is_private: false,
    category_id: category,
    category_source: category === null ? 'none' : f.category_id !== null ? 'manual' : 'rule',
    category_seen: true,
    tags: [],
    converted_to: null,
    source: 'page',
    raw_text: '',
    batch_id: null,
    created_at: now,
    updated_at: now,
  };
}

/** 前后两份表单变了的列；没变返回 null */
export function patchOf(_row: Readonly<Record<string, unknown>>, prev: NoteForm, next: NoteForm, now: number): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (titleCol(next.title) !== titleCol(prev.title)) out['title'] = titleCol(next.title);
  if (next.body !== prev.body) out['body'] = next.body;
  if (next.category_id !== prev.category_id) {
    out['category_id'] = next.category_id;
    // 改成“不分类”也算手动（用户自己定的，AI 之后也不来分）
    out['category_source'] = 'manual';
    out['category_seen'] = true;
  }
  if (Object.keys(out).length === 0) return null;
  out['updated_at'] = now;
  return out;
}
