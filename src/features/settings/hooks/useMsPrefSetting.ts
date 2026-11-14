// 设置 › 数据 › PPT 预览（B4b-1；线框 sPrev 第二张“这台设备只问一次，可以在 设置 › 数据 里改”）：普通随手记、隐私记各一行，三个值
// 先问（清掉本机记的，下次预览再出二选一卡）/ 预览（交给微软）/ 只下载。只记在这台设备（core/ms-pref.ts 的 localStorage），不进同步设置
import { useCallback, useState } from 'react';
import { readMsPref, writeMsPref, type MsPref, type MsScope } from '../../../core/ms-pref.ts';

export type MsChoice = 'ask' | MsPref;

export function useMsPrefSetting(scope: MsScope) {
  const [value, setValue] = useState<MsChoice>(() => readMsPref(scope) ?? 'ask');
  const set = useCallback(
    (v: MsChoice) => {
      writeMsPref(scope, v === 'ask' ? null : v);
      setValue(readMsPref(scope) ?? 'ask');
    },
    [scope],
  );
  return { value, set };
}
