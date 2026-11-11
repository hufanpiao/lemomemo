// 随手记转成待办 / 日程（B4 S8；TC-B4-08）：随手记转换只在这里做。
// 不变量：先新建目标行，再给原条写 converted_to（和 deleted_at：进“最近删除”），后一笔带 deps 指新条——服务器上先有新条再动原条，
//   新条被撤销抵消时原条那笔一起抵消；后一笔没写进去就撤回新条，撤不回的在结果里报出来（left），不让用户再点出第二条。
// 守门（已删、撤销、隐私记、只读行、内容为空、converted_to 认不出）一笔不写。rlog 只记长度和结果，不记文字。纯 TS，不准 React（A1）
import { todayOf } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { convertedToAfter, convertRow, type ConvertKind } from '../../../../shared/logic/notes/note-convert.ts';
import { saveOutcome, saveUndone, type SaveOutcome } from '../../../core/edit-save.ts';
import { readonlyIds } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Row } from './note-list.ts';

export type ConvertFail = Exclude<SaveOutcome, 'saved'> | 'empty' | 'gone';
type Ref = { table: 'todos' | 'events'; id: string };

export type ConvertResult =
  /** truncated：随手记的内容没能全部放进新条（标题或备注被截短了，见 shared 的 convertRow） */
  | { ok: true; table: Ref['table']; id: string; truncated: boolean }
  /** left：新条已建、撤回也没写进去（界面要提示，别让用户再转一次） */
  | { ok: false; reason: ConvertFail; left?: Ref };

export interface ConvertDeps {
  w?: Pick<typeof write, 'insert' | 'patch'>;
  newId?: () => string;
  isReadonly?: (noteId: string) => boolean;
}

export interface ConvertAt {
  now: number;
  tz: Tz;
  /** 保留原条（只记 converted_to，不进“最近删除”）：带附件的随手记（D-13）由调用方传 */
  keepNote?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function convertNote(note: Row, kind: ConvertKind, at: ConvertAt, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const { w = write, newId = () => crypto.randomUUID(), isReadonly = (id: string) => readonlyIds('notes').getSnapshot().has(id) } = deps;
  const done = (r: ConvertResult): ConvertResult => {
    rlog(`note convert ${kind} ${r.ok ? `ok truncated=${r.truncated}` : `${r.reason}${r.left ? ' left' : ''}`} title=${str(note['title']).length} body=${str(note['body']).length}`);
    return r;
  };
  if (!isLiveRow(note)) return done({ ok: false, reason: 'gone' });
  // 隐私记的 converted_to 必须为空（数据字典），客户端也改不了隐私记行
  if (note['is_private'] === true) return done({ ok: false, reason: 'rejected' });
  if (isReadonly(note.id)) return done({ ok: false, reason: 'readonly' });
  const id = newId();
  const r = convertRow({ id: note.id, title: note['title'], body: note['body'] }, kind, { id, batchId: newId(), now: at.now, today: todayOf(at.now, at.tz), tz: at.tz });
  if (!r) return done({ ok: false, reason: 'empty' });
  const next = convertedToAfter(note['converted_to'], { kind, id });
  if (!next) return done({ ok: false, reason: 'rejected' });

  const made = await saveOutcome(() => w.insert(r.table, { ...r.row }, {}));
  if (made !== 'saved') return done({ ok: false, reason: made });
  const patch = at.keepNote ? { converted_to: next, updated_at: at.now } : { converted_to: next, deleted_at: at.now, updated_at: at.now };
  const moved = await saveOutcome(() => w.patch('notes', note.id, patch, { deps: [{ table: r.table, id }] }));
  if (moved === 'saved') return done({ ok: true, table: r.table, id, truncated: r.truncated });
  // 还没发出的 insert 会和这笔撤销抵消；已发出的写 undone（同“＋”整批撤回）
  const undone = await saveUndone(r.table, id, at.now, w);
  return done(undone === 'saved' ? { ok: false, reason: moved } : { ok: false, reason: moved, left: { table: r.table, id } });
}
