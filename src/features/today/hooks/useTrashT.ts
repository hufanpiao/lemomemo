// “最近删除”页自己的 t()（B4 S2）：词典在 ../i18n/trash-zh.ts、trash-ko.ts（从今天页的词典拆出，不进首屏）；语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { trashKo } from '../i18n/trash-ko.ts';
import { trashZh } from '../i18n/trash-zh.ts';

export type TrashMsgKey = keyof typeof trashZh & string;

const tTrash = createT({ zh: trashZh, ko: trashKo });

export function useTrashT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends TrashMsgKey>(key: K, params: ParamsOf<typeof trashZh, K>): string => tTrash(key, params, locale), [locale]);
}
