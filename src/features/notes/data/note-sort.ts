// 随手记、隐私记的长按拖动排序：手势和落点在 kit 的 SortDrag，这里只算“要写什么”和写。
// • 排序值：按松手后页面上这一串的顺序算（shared/logic/sort-key.ts 的 planMove）。随手记没拖过的条目按 created_at 的时间键当排序值（effKey），
//   邻居总有键，一般只写拖的这一条；按天分组时页面上的顺序就是时间顺序，切到“自己排”以后这一条正好落在那条横线的位置
// • 按时间排时拖（松手后切到“自己排”，reset）：这一串里以前拖过、留着旧 sort_key 的条一起写 null（回到按记的时刻排），
//   不然切过去它们按旧键跳走，顺序和松手时那条横线对不上
// • 撤销写回原来真正的 sort_key（没拖过的写回 null，不是时间键）
// • 写入经来源的 editIo（普通随手记进 outbox；隐私记改内存仓库、后台队列带着 sort_key 发 vault save，排序值进密文）；不改 updated_at（换个位置不算改了内容）
// 纯 TS：不准 import React
import { planMove } from '../../../../shared/logic/sort-key.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import type { SaveOutcome } from '../../../core/edit-save.ts';

/** 写一笔（来源的 editIo.patch 就是这个形状；data 层不 import kit 的 hook，只写形状） */
export type NotePatchIo = { patch(table: string, id: string, data: Record<string, unknown>, remind: boolean): Promise<SaveOutcome> };
import type { NoteItem } from './note-list.ts';

export interface NoteKeyWrite {
  id: string;
  /** 新的 sort_key；null = 清掉（见文件头 reset） */
  key: string | null;
  /** 原来的 sort_key（没拖过为 null） */
  prev: string | null;
}

/** shown：页面上这一串（显示顺序，含拖的这一条）；index：放下后排第几（按去掉它以后数）；reset：按时间排时拖的（见文件头） */
export function planNoteDrop(shown: readonly Pick<NoteItem, 'id' | 'key' | 'sortKey'>[], id: string, index: number, now: number, reset = false): NoteKeyWrite[] {
  const real = new Map(shown.map((x) => [x.id, x.sortKey]));
  const moves: NoteKeyWrite[] = planMove(shown.map((x) => ({ id: x.id, key: x.key })), id, index, now).map((w) => ({ id: w.id, key: w.key, prev: real.get(w.id) ?? null }));
  if (!reset) return moves;
  const moved = new Set(moves.map((w) => w.id));
  return [...moves, ...shown.filter((x) => x.sortKey !== null && !moved.has(x.id)).map((x) => ({ id: x.id, key: null, prev: x.sortKey }))];
}

/** 这一批一起发出去（undo 写回原来的；不在中间等）；有一笔没成回第一笔没成的结果，调用方整批撤回 */
export async function applyNoteSort(io: NotePatchIo, writes: readonly NoteKeyWrite[], undo: boolean): Promise<ActionResult> {
  const res = await Promise.all(writes.map(async (w) => actionResult(await io.patch('notes', w.id, { sort_key: undo ? w.prev : w.key }, false))));
  return res.find((r) => r !== 'ok') ?? 'ok';
}
