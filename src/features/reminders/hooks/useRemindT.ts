// 提醒功能的 t()（B2 FA-4）：词典在 ../i18n/zh.ts、ko.ts，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { remindKo } from '../i18n/ko.ts';
import { remindZh } from '../i18n/zh.ts';

export type RemindMsgKey = keyof typeof remindZh & string;

export const tRemind = createT({ zh: remindZh, ko: remindKo });

export function useRemindT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends RemindMsgKey>(key: K, params: ParamsOf<typeof remindZh, K>): string => tRemind(key, params, locale), [locale]);
}

export type RemindT = ReturnType<typeof useRemindT>;
