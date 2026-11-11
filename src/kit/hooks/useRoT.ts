// 只读行界面词典的 t（shared/i18n/ro-zh.ts、ro-ko.ts；FA-2，11-06 挪出公共词典、不进首屏）：写法同 useT，语言变了跟着重画
import { roKo } from '../../../shared/i18n/ro-ko.ts';
import { roZh } from '../../../shared/i18n/ro-zh.ts';
import { makeUseT } from './useT.ts';

export const useRoT = makeUseT({ zh: roZh, ko: roKo });
