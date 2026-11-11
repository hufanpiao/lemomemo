// 提醒功能首屏那几句的 t()（首屏瘦身 H1 第三轮）：只带 ../i18n/row-zh.ts、row-ko.ts 这几句，不带整本提醒词典；
// 今天页“错过 N 条提醒”一行、“未同步”提示和行尾标记用。整本词典（useRemindT）里没有这几个键
import { remindRowKo } from '../i18n/row-ko.ts';
import { remindRowZh } from '../i18n/row-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type RemindRowMsgKey = keyof typeof remindRowZh & string;

export const useRemindRowT = makeUseT({ zh: remindRowZh, ko: remindRowKo });
