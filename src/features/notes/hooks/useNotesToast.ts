// 随手记页提示条里自己的两样（B4）：删除撤销、只读拦截、出错条走 kit 的 useListActions（提示条状态在它的 g 里），这里只管
// • 插图提示（S3）、转换结果（R-414）、出错条 4 秒后自己收起；空间满了、带“最近删除”入口的插图提示留 8 秒，来得及点
// • 返回值 up：撤销条或只读提示条出着，底部输入行往上让一格
import { useEffect } from 'react';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';

export function useNotesToast<X extends { kind: string; trash?: boolean }>(g: ReadonlyGuard<ListToast | X>): boolean {
  const { toast } = g;
  useEffect(() => {
    if (toast === null || toast.kind === 'undo') return undefined;
    const id = setTimeout(() => g.dismiss(toast), 'trash' in toast && toast.trash === true ? 8000 : 4000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- g 每次重画都是新对象（useReadonlyGuard 不包 useCallback），放进去会让计时每画一次就重来；dismiss 只按 toast 收，用哪一次的都一样
  }, [toast]);
  return toast?.kind === 'undo' || g.toastAt !== null;
}
