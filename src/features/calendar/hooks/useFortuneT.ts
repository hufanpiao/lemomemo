// 今日运势卡的 t()：词典在 ../i18n/fortune-zh.ts、fortune-ko.ts，语言跟着 ui-store 的 locale；只给按需加载的运势卡用
import { fortuneKo } from '../i18n/fortune-ko.ts';
import { fortuneZh } from '../i18n/fortune-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export const useFortuneT = makeUseT({ zh: fortuneZh, ko: fortuneKo });

export type FortuneT = ReturnType<typeof useFortuneT>;
