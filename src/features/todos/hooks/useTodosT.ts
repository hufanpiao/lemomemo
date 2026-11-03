// 功能 todos 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type TodosMsgKey = keyof typeof zh & string;

const tTodos = createT({ zh, ko });

export function useTodosT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends TodosMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => tTodos(key, params, locale), [locale]);
}
