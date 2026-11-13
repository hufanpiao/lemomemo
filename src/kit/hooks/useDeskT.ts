// 电脑版布局词典的 t（shared/i18n/desk-zh.ts、desk-ko.ts；B6，不进首屏）：写法同 useRoT，语言变了跟着重画
import { deskKo } from '../../../shared/i18n/desk-ko.ts';
import { deskZh } from '../../../shared/i18n/desk-zh.ts';
import { makeUseT } from './useT.ts';

export const useDeskT = makeUseT({ zh: deskZh, ko: deskKo });
