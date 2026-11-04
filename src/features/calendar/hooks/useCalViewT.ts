// 月历、周视图页面的 t()（B2 FA-3）：词典在 ../i18n/view-zh.ts、view-ko.ts，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { viewKo } from '../i18n/view-ko.ts';
import { viewZh } from '../i18n/view-zh.ts';

export type CalViewMsgKey = keyof typeof viewZh & string;

const tView = createT({ zh: viewZh, ko: viewKo });

export function useCalViewT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends CalViewMsgKey>(key: K, params: ParamsOf<typeof viewZh, K>): string => tView(key, params, locale), [locale]);
}

export type CalViewT = ReturnType<typeof useCalViewT>;
