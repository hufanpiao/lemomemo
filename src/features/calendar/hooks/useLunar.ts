// 农历、节气：shared/logic/anniv/lunar.ts 按需加载（单独 chunk，不进入口）
// • 加载只走 core/anniv-lib.ts 的 LUNAR_LIB 和 kit 的 useLazyLib，这里不另写 import() 和模块级缓存：
//   同一会话只加载一次，翻月、换页不再加载
// • 加载中、加载失败：返回 null，月格照常显示、没有农历行（格子里农历行的位置一直占着，加载完不跳动）；
//   失败记一行运行日志 `lunar lib-load failed`，断网恢复（online）或换回中文界面时重试
// • 只有中文界面加载（韩文界面月历不显示农历和节气）：韩文界面不下这个 chunk、返回 null。
//   以后韩国阴历数据进来、韩文界面也要显示时，再放开这一条
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { LUNAR_LIB, type LazyLib, type LunarLib } from '../../../core/anniv-lib.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';

export interface LunarApi {
  /** 当 buildMonth 的 MonthOpts.dayInfo：格子里的短写法和节气名 */
  readonly dayInfo: (date: DateStr) => { readonly lunar?: string; readonly solarTerm?: string };
  /** 读屏用的完整写法（“九月十五”“윤2월 11일”）；没有数据时 undefined */
  readonly fullText: (date: DateStr) => string | undefined;
}

let lib: LazyLib<LunarLib> = LUNAR_LIB;

/** 只有中文界面走到这里（韩文界面 useLazyLib 返回 'off'，不会 ready），按中国农历算；以后放开韩文界面时这里按 locale 换 'kr' */
function apiOf(m: LunarLib, locale: UiLocale): LunarApi {
  return {
    dayInfo: (date) => m.lunarDayInfo(date, locale),
    fullText: (date) => {
      const l = m.toLunar(date, 'cn');
      return l === null ? undefined : m.lunarText(l, locale);
    },
  };
}

export function useLunar(locale: UiLocale): LunarApi | null {
  const wanted = locale !== 'ko-KR';
  const ready = useLazyLib(lib, wanted) === 'ready';
  // 同一个模块、同一种语言时给同一个对象（月格的 useMemo 靠它不重算）
  return useMemo(() => (ready ? apiOf(lib.get(), locale) : null), [ready, locale]);
}

/** 测试用：换一个新建的 lazyLib 实例（core/anniv-lib.ts 的 lazyLib），模拟慢加载、加载失败；每条用例换一个新的，互不串 */
export function resetLunarForTest(l: LazyLib<LunarLib>): void {
  lib = l;
}
