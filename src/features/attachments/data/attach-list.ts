// 一条随手记的附件列表（线框 sAtt“附件 4 · 共 8.1 MB”、列表行尾“附件 N”）：note_files 行 → 界面要的字段
// • 只列活着的（没删、没撤销）普通附件；隐私记的行（is_vault）这一批不出（隐私记附件没做，见交回报告）
// • 按 id 排（UUID v7，按加入先后）
// 纯 TS：不准 import React（A1）
import { isShownFile } from '../../../../shared/logic/files/shown-file.ts';
import type { FileRef } from './attach-open.ts';

export type Row = { id: string } & Record<string, unknown>;

export interface NoteFile extends FileRef {
  noteId: string;
  bytes: number;
  /** 服务器复查的结果：pending 正在检查，ok 能预览下载，rejected 没收 */
  check: 'pending' | 'ok' | 'rejected';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toFile(r: Row): NoteFile | null {
  if (!isShownFile(r)) return null;
  const noteId = str(r['note_id']);
  const path = str(r['path']);
  if (noteId === '' || path === '') return null;
  const c = r['check_status'];
  return {
    id: r.id,
    noteId,
    path,
    kind: r['kind'],
    name: str(r['name']) || `file.${r['kind']}`,
    sha256: str(r['sha256']),
    bytes: typeof r['bytes'] === 'number' ? r['bytes'] : 0,
    check: c === 'ok' || c === 'rejected' ? c : 'pending',
  };
}

/** 活着的附件按随手记分好，每条里按 id（加入先后）排 */
export function filesByNote(rows: readonly Row[]): Map<string, NoteFile[]> {
  const out = new Map<string, NoteFile[]>();
  for (const r of rows) {
    const f = toFile(r);
    if (!f) continue;
    const l = out.get(f.noteId) ?? [];
    l.push(f);
    out.set(f.noteId, l);
  }
  for (const l of out.values()) l.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
