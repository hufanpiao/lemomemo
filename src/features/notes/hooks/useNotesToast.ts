// 随手记页提示条里自己的两样（B4）：删除撤销、只读拦截、出错条走 kit 的 useListActions（提示条状态在它的 g 里），这里只管
// • 插图提示（S3）、转换结果（R-414）、出错条 4 秒后自己收起；空间满了、带“最近删除”入口的插图提示留 8 秒，来得及点
// • 撤销条（删除的 undo、合并分类的 mergeUndo，R-415 ③）由 kit 的 UndoToast 自己计 8 秒，这里不收；isUndo 是“哪些算撤销条”的唯一口径
// • 返回值 up：撤销条或只读提示条出着，底部输入行往上让一格
import { useEffect } from 'react';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';

/** 撤销条：删除的（kit 的 undo，id 是随手记）、合并分类的（mergeUndo，id 是被合并的分类） */
export type UndoTip = { kind: 'undo' | 'mergeUndo'; id: string };

export function isUndo<T extends { kind: string }>(t: T | null): t is Extract<T, UndoTip> {
  return t?.kind === 'undo' || t?.kind === 'mergeUndo';
}

export function useNotesToast<X extends { kind: string; trash?: boolean }>(g: ReadonlyGuard<ListToast | X>): boolean {
  const { toast } = g;
  useEffect(() => {
    if (toast === null || isUndo(toast)) return undefined;
    const id = setTimeout(() => g.dismiss(toast), 'trash' in toast && toast.trash === true ? 8000 : 4000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- g 每次重画都是新对象（useReadonlyGuard 不包 useCallback），放进去会让计时每画一次就重来；dismiss 只按 toast 收，用哪一次的都一样
  }, [toast]);
  return isUndo(toast) || g.toastAt !== null;
}
