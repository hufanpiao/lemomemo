// sync-notice 的 t()（K8 冲突提示）：词典在 ../i18n/zh.ts、ko.ts，语言跟着 ui-store 的 locale（写法同 reminders 的 useRemindT）
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { syncNoticeKo } from '../i18n/ko.ts';
import { syncNoticeZh } from '../i18n/zh.ts';

export type SnKey = keyof typeof syncNoticeZh & string;

export const tSn = createT({ zh: syncNoticeZh, ko: syncNoticeKo });

export function useSnT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends SnKey>(key: K, params: ParamsOf<typeof syncNoticeZh, K>): string => tSn(key, params, locale), [locale]);
}

export type SnT = ReturnType<typeof useSnT>;
