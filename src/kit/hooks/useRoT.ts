// 只读行界面词典的 t（shared/i18n/ro-zh.ts、ro-ko.ts；FA-2，11-06 挪出公共词典、不进首屏）：写法同 useT，语言变了跟着重画
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../shared/i18n/i18n.ts';
import { roKo } from '../../../shared/i18n/ro-ko.ts';
import { roZh, type RoMsgKey } from '../../../shared/i18n/ro-zh.ts';
import { useUi } from '../state/ui-store.ts';

const tRo = createT({ zh: roZh, ko: roKo });

export function useRoT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends RoMsgKey>(key: K, params: ParamsOf<typeof roZh, K>): string => tRo(key, params, locale), [locale]);
}
