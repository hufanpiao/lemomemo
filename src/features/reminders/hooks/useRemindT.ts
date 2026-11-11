// 提醒功能的 t()（B2 FA-4）：词典在 ../i18n/zh.ts、ko.ts，语言跟着 ui-store 的 locale
import { createT } from '../../../../shared/i18n/i18n.ts';
import { remindKo } from '../i18n/ko.ts';
import { remindZh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type RemindMsgKey = keyof typeof remindZh & string;

export const tRemind = createT({ zh: remindZh, ko: remindKo });

export const useRemindT = makeUseT({ zh: remindZh, ko: remindKo });

export type RemindT = ReturnType<typeof useRemindT>;
