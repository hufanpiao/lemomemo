// 功能 auth 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { type ParamNames } from '../../../../shared/i18n/i18n.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type AuthMsgKey = keyof typeof zh & string;

/** 没有占位符的词条（可以直接 t(key, {})） */
export type AuthPlainKey = { [K in AuthMsgKey]: [ParamNames<(typeof zh)[K]>] extends [never] ? K : never }[AuthMsgKey];

export const useAuthT = makeUseT({ zh, ko });
