// 翻译钩子只在这里造（架构 10.1“翻译钩子”唯一出口）：makeUseT(一对中韩词典) 返回这本词典的 useXxxT()，语言跟着 ui-store 的 locale 变
// 公共词典的 useT 也由它造；功能自己的词典在功能的 hooks 里调 makeUseT，不再各写一份 useCallback
// 公共词典按语言懒加载（首屏瘦身 D，11-17）：useT 查 shared/i18n/i18n.ts 的 sharedT，只有当前语言那一份；
// 下载由 platform/doc-locale.ts 的 loadSharedDict 管，入口渲染前、切换语言前先等它，所以这里拿到的语言一定已经下载好
import { useCallback } from 'react';
import { createT, sharedT, type Dict, type Locale, type ParamsOf, type SharedDict } from '../../../shared/i18n/i18n.ts';
import { useUi } from '../state/ui-store.ts';

type Translate<D extends Dict> = <K extends keyof D & string>(key: K, params: ParamsOf<D, K>, locale: Locale) => string;

function hookOf<D extends Dict>(tr: Translate<D>) {
  return function useDictT() {
    const locale = useUi((s) => s.locale);
    return useCallback(<K extends keyof D & string>(key: K, params: ParamsOf<D, K>): string => tr(key, params, locale), [locale]);
  };
}

export function makeUseT<D extends Dict>(dicts: { zh: D; ko: Readonly<Record<keyof D, string>> }) {
  return hookOf(createT(dicts));
}

export const useT = hookOf<SharedDict>(sharedT);
