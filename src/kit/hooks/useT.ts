// 当前语言的 t()（架构 2.4）：语言变了，用到它的组件跟着重画
// 功能自己的词典：在功能的 hooks 里用 createT 造一个，再按同样的写法包一层
import { useCallback } from 'react';
import { t, type ParamsOf, type SharedMsgKey } from '../../../shared/i18n/i18n.ts';
import type { zh } from '../../../shared/i18n/zh.ts';
import { useUi } from '../state/ui-store.ts';

export function useT() {
  const locale = useUi((s) => s.locale);
  return useCallback(
    <K extends SharedMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => t(key, params, locale),
    [locale],
  );
}
