// 功能 calendar 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type CalendarMsgKey = keyof typeof zh & string;

export const useCalendarT = makeUseT({ zh, ko });
