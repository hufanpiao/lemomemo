// 月历、周视图页面的 t()（B2 FA-3）：词典在 ../i18n/view-zh.ts、view-ko.ts，语言跟着 ui-store 的 locale
import { viewKo } from '../i18n/view-ko.ts';
import { viewZh } from '../i18n/view-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type CalViewMsgKey = keyof typeof viewZh & string;

export const useCalViewT = makeUseT({ zh: viewZh, ko: viewKo });

export type CalViewT = ReturnType<typeof useCalViewT>;
