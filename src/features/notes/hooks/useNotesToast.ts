// 随手记页提示条里自己的两样：删除撤销、只读拦截、出错条走 kit 的 useListActions（提示条状态在它的 g 里），这里只管
// • 插图提示、转换结果、出错条：kit 的 g.show 默认 TOAST_MS 后自己收起（全 app 统一，这里不另计时）
// • 撤销条（删除的、合并分类的、拖动的）由 kit 的 UndoToast 自己计时，show 时传 null；isUndo 是“哪些算撤销条”的唯一口径，
//   画成什么、点了做什么统一成一份 UndoTip（undoTipOf），页面的 UndoBar 只管画
// • noteBarUp：撤销条或只读提示条出着，底部输入行往上让一格
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import type { NotesMsgKey } from './useNotesT.ts';

/** 页底撤销条的一份：文案、test id、点了撤销做什么；key 换了就是新的一条（重新计 5 秒） */
export interface UndoTip {
  key: string;
  msgKey: Extract<NotesMsgKey, 'notes.deleted' | 'notes.merge.done' | 'notes.moved' | 'notes.order.switched'>;
  testId: 'notes-toast' | 'notes-merge-toast' | 'notes-moved-toast';
  undo(): void;
}
/** 合并分类后的撤销条：自带 UndoTip，放进和删除撤销条同一个提示条位置；pair 是合并的那一对（useMergeHint 的 key），撤销条在时提示条不出它 */
export type MergeUndo = { kind: 'mergeUndo'; pair: string } & UndoTip;
/** 拖动放下后的撤销条：组内换序“已移动 · 撤销”；顺手切到了自己排的那一次是“已切到自己排，设置里可改回 · 撤销” */
export type MoveUndo = { kind: 'moveUndo' } & UndoTip;
type DeleteUndo = Extract<ListToast, { kind: 'undo' }>;

let seq = 0;
/** 合并成了出的撤销条：每次一个新 key（连着合并两对，第二条重新计时） */
export const mergeUndo = (pair: string, undo: () => void): MergeUndo => ({ kind: 'mergeUndo', pair, key: `merge:${++seq}`, msgKey: 'notes.merge.done', testId: 'notes-merge-toast', undo });

/** 拖动放下成了出的撤销条：每次一个新 key */
export const moveUndo = (switched: boolean, undo: () => void): MoveUndo => ({
  kind: 'moveUndo', key: `move:${++seq}`, msgKey: switched ? 'notes.order.switched' : 'notes.moved', testId: 'notes-moved-toast', undo,
});

export function isUndo<T extends { kind: string }>(t: T | null): t is Extract<T, DeleteUndo | MergeUndo | MoveUndo> {
  return t?.kind === 'undo' || t?.kind === 'mergeUndo' || t?.kind === 'moveUndo';
}

/** 撤销条 → 画的那一份：合并、拖动的本来就是；删除的是 kit 的 {kind: 'undo', id}（今天页、待办页共用这个形状），在这里补上文案和撤销 */
export const undoTipOf = (t: DeleteUndo | MergeUndo | MoveUndo, undoDelete: (id: string) => void): UndoTip =>
  t.kind === 'undo' ? { key: `undo:${t.id}`, msgKey: 'notes.deleted', testId: 'notes-toast', undo: () => undoDelete(t.id) } : t;

/** 撤销条或只读提示条出着：底部输入行往上让一格 */
export function noteBarUp<X extends { kind: string }>(g: ReadonlyGuard<ListToast | X>): boolean {
  return isUndo(g.toast) || g.toastAt !== null;
}
