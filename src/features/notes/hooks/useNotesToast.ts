// 随手记页的提示条状态（B4；S12 只读行，R-148，TC-B4-09；照待办页）：页面自己的提示条（撤销条、出错条、“插图很快上线”）和
// kit 的只读提示条“这条要新版本才能修改 · 更新”（useReadonlyGuard）同时只出一条。从 ui/NotesPage.tsx 挪出来（函数不超过 150 行）
// • isRo：这一条在 core 的只读 id 里（带认不出的值）；点开、删除先判它，是就 block()（不进编辑器、不开抽屉、不写）
// • report：写入回 readonly 也走 block()，回 failed 出页面的出错条
// • up：撤销条（raised 判断）或只读提示条出着，底部输入行往上让一格
import { useState } from 'react';
import { useReadonlyGuard, useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import type { ActionResult } from './useNoteList.ts';

export function useNotesToast<T>(error: T, raised: (x: T) => boolean) {
  const [toast, setToast] = useState<T | null>(null);
  const guard = useReadonlyGuard();
  const ro = useReadonlyIds('notes');
  const block = (): void => {
    setToast(null);
    guard.block();
  };
  const show = (x: T): void => {
    guard.close();
    setToast(x);
  };
  const report = (r: ActionResult): void => {
    if (r === 'readonly') block();
    else if (r === 'failed') show(error);
  };
  return { toast, setToast, guard, isRo: (id: string) => ro.has(id), block, show, report, up: (toast !== null && raised(toast)) || guard.toastAt !== null };
}
