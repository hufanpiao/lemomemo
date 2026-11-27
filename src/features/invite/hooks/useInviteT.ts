// 功能 invite 自己的 t()：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type InviteMsgKey = keyof typeof zh & string;

export const useInviteT = makeUseT({ zh, ko });
