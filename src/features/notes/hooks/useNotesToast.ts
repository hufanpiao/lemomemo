// 随手记页提示条里自己的两样（B4）：删除撤销、只读拦截、出错条走 kit 的 useListActions（提示条状态在它的 g 里），这里只管
// • 插图提示（S3）、转换结果（R-414）、出错条 4 秒后自己收起；空间满了、带“最近删除”入口的插图提示留 8 秒，来得及点
// • 撤销条（删除的、合并分类的，R-415 ③）由 kit 的 UndoToast 自己计 8 秒，这里不收；isUndo 是“哪些算撤销条”的唯一口径，
//   画成什么、点了做什么统一成一份 UndoTip（undoTipOf），页面的 UndoBar 只管画
// • 返回值 up：撤销条或只读提示条出着，底部输入行往上让一格
import { useEffect } from 'react';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import type { NotesMsgKey } from './useNotesT.ts';

/** 页底撤销条的一份：文案、test id、点了撤销做什么；key 换了就是新的一条（重新计 8 秒） */
export interface UndoTip {
  key: string;
  msgKey: Extract<NotesMsgKey, 'notes.deleted' | 'notes.merge.done'>;
  testId: 'notes-toast' | 'notes-merge-toast';
  undo(): void;
}
/** 合并分类后的撤销条（R-415 ③）：自带 UndoTip，放进和删除撤销条同一个提示条位置；pair 是合并的那一对（useMergeHint 的 key），撤销条在时提示条不出它 */
export type MergeUndo = { kind: 'mergeUndo'; pair: string } & UndoTip;
type DeleteUndo = Extract<ListToast, { kind: 'undo' }>;

let seq = 0;
/** 合并成了出的撤销条：每次一个新 key（连着合并两对，第二条重新计时） */
export const mergeUndo = (pair: string, undo: () => void): MergeUndo => ({ kind: 'mergeUndo', pair, key: `merge:${++seq}`, msgKey: 'notes.merge.done', testId: 'notes-merge-toast', undo });

export function isUndo<T extends { kind: string }>(t: T | null): t is Extract<T, DeleteUndo | MergeUndo> {
  return t?.kind === 'undo' || t?.kind === 'mergeUndo';
}

/** 撤销条 → 画的那一份：合并的本来就是；删除的是 kit 的 {kind: 'undo', id}（今天页、待办页共用这个形状），在这里补上文案和撤销 */
export const undoTipOf = (t: DeleteUndo | MergeUndo, undoDelete: (id: string) => void): UndoTip =>
  t.kind === 'mergeUndo' ? t : { key: `undo:${t.id}`, msgKey: 'notes.deleted', testId: 'notes-toast', undo: () => undoDelete(t.id) };

export function useNotesToast<X extends { kind: string; trash?: boolean }>(g: ReadonlyGuard<ListToast | X>): boolean {
  const { toast } = g;
  useEffect(() => {
    if (toast === null || isUndo(toast)) return undefined;
    const id = setTimeout(() => g.dismiss(toast), 'trash' in toast && toast.trash === true ? UNDO_TOAST_MS : 4000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- g 每次重画都是新对象（useReadonlyGuard 不包 useCallback），放进去会让计时每画一次就重来；dismiss 只按 toast 收，用哪一次的都一样
  }, [toast]);
  return isUndo(toast) || g.toastAt !== null;
}
