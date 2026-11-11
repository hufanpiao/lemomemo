// 翻译钩子只在这里造（架构 10.1“翻译钩子”唯一出口）：makeUseT(一对中韩词典) 返回这本词典的 useXxxT()，语言跟着 ui-store 的 locale 变
// 公共词典的 useT 也由它造；功能自己的词典在功能的 hooks 里调 makeUseT，不再各写一份 useCallback
import { useCallback } from 'react';
import { createT, type Dict, type ParamsOf } from '../../../shared/i18n/i18n.ts';
import { ko } from '../../../shared/i18n/ko.ts';
import { zh } from '../../../shared/i18n/zh.ts';
import { useUi } from '../state/ui-store.ts';

export function makeUseT<D extends Dict>(dicts: { zh: D; ko: Readonly<Record<keyof D, string>> }) {
  const tr = createT(dicts);
  return function useDictT() {
    const locale = useUi((s) => s.locale);
    return useCallback(<K extends keyof D & string>(key: K, params: ParamsOf<D, K>): string => tr(key, params, locale), [locale]);
  };
}

export const useT = makeUseT({ zh, ko });
