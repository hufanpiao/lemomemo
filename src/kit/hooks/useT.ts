// 翻译钩子只在这里造：makeUseT(一对中韩词典) 返回这本词典的 useXxxT()，语言跟着 ui-store 的 locale 变
// 公共词典的 useT 也由它造；功能自己的词典在功能的 hooks 里调 makeUseT，不各写一份 useCallback
// 公共词典按语言懒加载：useT 查 shared/i18n/i18n.ts 的 sharedT，并用 useSyncExternalStore 订阅“又下载好了一份”：
// 切换语言后才到的那份一放进来，用到 useT 的组件就重画，不会停在另一种语言或启动兜底上
import { useCallback, useSyncExternalStore } from 'react';
import {
  createT, sharedDictSnapshot, sharedT, subscribeSharedDict, type Dict, type Locale, type ParamsOf, type SharedDict,
} from '../../../shared/i18n/i18n.ts';
import { useUi } from '../state/ui-store.ts';

type Translate<D extends Dict> = <K extends keyof D & string>(key: K, params: ParamsOf<D, K>, locale: Locale) => string;

/** 词典本身会不会变：功能词典静态带着，不会变（回同一个值）；公共词典按语言懒加载，订阅它 */
const staticDict = (): undefined => undefined;
const useSharedDicts = (): object => useSyncExternalStore(subscribeSharedDict, sharedDictSnapshot, sharedDictSnapshot);

function hookOf<D extends Dict>(tr: Translate<D>, useDicts: () => unknown) {
  return function useDictT() {
    const locale = useUi((s) => s.locale);
    const dicts = useDicts();
    // dicts 只用来在词典换了时换一个新函数（用到它的 memo、effect 跟着重算）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useCallback(<K extends keyof D & string>(key: K, params: ParamsOf<D, K>): string => tr(key, params, locale), [locale, dicts]);
  };
}

export function makeUseT<D extends Dict>(dicts: { zh: D; ko: Readonly<Record<keyof D, string>> }) {
  return hookOf(createT(dicts), staticDict);
}

export const useT = hookOf<SharedDict>(sharedT, useSharedDicts);
