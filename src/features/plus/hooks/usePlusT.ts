// 功能 plus 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, fill, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type PlusMsgKey = keyof typeof zh & string;

const tPlus = createT({ zh, ko });

export function usePlusT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends PlusMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => tPlus(key, params, locale), [locale]);
}

/** 参数在运行时才定的词条（提示条的几行，data/notice.ts 给 key 和参数）：直接查词典再填参数，不用 as */
export function usePlusLine() {
  const locale = useUi((s) => s.locale);
  return useCallback(
    (key: PlusMsgKey, params: Readonly<Record<string, string | number>>): string => fill(locale === 'ko-KR' ? ko[key] : zh[key], params),
    [locale],
  );
}
