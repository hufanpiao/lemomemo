// 提醒功能首屏那几句的 t()（首屏瘦身 H1 第三轮）：只带 ../i18n/row-zh.ts、row-ko.ts 这几句，不带整本提醒词典；
// 今天页“错过 N 条提醒”一行、“未同步”提示和行尾标记用。整本词典（useRemindT）里没有这几个键
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { remindRowKo } from '../i18n/row-ko.ts';
import { remindRowZh } from '../i18n/row-zh.ts';

export type RemindRowMsgKey = keyof typeof remindRowZh & string;

const tRow = createT({ zh: remindRowZh, ko: remindRowKo });

export function useRemindRowT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends RemindRowMsgKey>(key: K, params: ParamsOf<typeof remindRowZh, K>): string => tRow(key, params, locale), [locale]);
}
