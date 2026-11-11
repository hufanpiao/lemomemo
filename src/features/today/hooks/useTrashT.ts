// “最近删除”页自己的 t()（B4 S2）：词典在 ../i18n/trash-zh.ts、trash-ko.ts（从今天页的词典拆出，不进首屏）；语言跟着 ui-store 的 locale
import { trashKo } from '../i18n/trash-ko.ts';
import { trashZh } from '../i18n/trash-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type TrashMsgKey = keyof typeof trashZh & string;

export const useTrashT = makeUseT({ zh: trashZh, ko: trashKo });
