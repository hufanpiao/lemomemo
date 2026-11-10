// 功能 notes 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type NotesMsgKey = keyof typeof zh & string;

const tNotes = createT({ zh, ko });

export function useNotesT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends NotesMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => tNotes(key, params, locale), [locale]);
}
