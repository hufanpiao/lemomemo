// 功能 auth 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamNames, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type AuthMsgKey = keyof typeof zh & string;

/** 没有占位符的词条（可以直接 t(key, {})） */
export type AuthPlainKey = { [K in AuthMsgKey]: [ParamNames<(typeof zh)[K]>] extends [never] ? K : never }[AuthMsgKey];

const tAuth = createT({ zh, ko });

export function useAuthT() {
  const locale = useUi((s) => s.locale);
  return useCallback(
    <K extends AuthMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => tAuth(key, params, locale),
    [locale],
  );
}
