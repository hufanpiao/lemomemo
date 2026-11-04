// 农历、节气（B2 FA-3，架构 5.4、5.12）：后端的 shared/logic/anniv/lunar.ts 按需加载（单独 chunk，不进入口，2.6）
// • 第一次用到时 import()，模块级缓存：同一会话只加载一次，翻月、换页不再加载
// • 加载中、加载失败：返回 null，月格照常显示、没有农历行（格子里农历行的位置一直占着，加载完不跳动）；失败不重试、不报错
// • 只有中文界面加载（R-318、R-321：韩文界面月历不显示农历和节气）：韩文界面不下这个 chunk、返回 null（代码审查 L7）。
//   以后韩国阴历数据进来、负责人要韩文界面也显示时，再放开这一条
import { useEffect, useMemo, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
// 只取类型（编译后擦掉，不会把 lunar.ts 打进这个 chunk）；真正加载在 defaultLoad 的 import()
import type * as LunarNs from '../../../../shared/logic/anniv/lunar.ts';

type LunarModule = typeof LunarNs;

export interface LunarApi {
  /** 当 buildMonth 的 MonthOpts.dayInfo：格子里的短写法和节气名 */
  readonly dayInfo: (date: DateStr) => { readonly lunar?: string; readonly solarTerm?: string };
  /** 读屏用的完整写法（“九月十五”“윤2월 11일”）；没有数据时 undefined */
  readonly fullText: (date: DateStr) => string | undefined;
}

const defaultLoad = (): Promise<LunarModule> => import('../../../../shared/logic/anniv/lunar.ts');

let load: () => Promise<LunarModule> = defaultLoad;
/** undefined：还没开始；null：加载失败 */
let mod: LunarModule | null | undefined;
let pending: Promise<LunarModule | null> | null = null;

function ensure(): Promise<LunarModule | null> {
  if (mod !== undefined) return Promise.resolve(mod);
  pending ??= load().then(
    (m) => (mod = m),
    () => (mod = null),
  );
  return pending;
}

function apiOf(m: LunarModule, locale: UiLocale): LunarApi {
  const variant = locale === 'ko-KR' ? 'kr' : 'cn';
  return {
    dayInfo: (date) => m.lunarDayInfo(date, locale),
    fullText: (date) => {
      const l = m.toLunar(date, variant);
      return l === null ? undefined : m.lunarText(l, locale);
    },
  };
}

export function useLunar(locale: UiLocale): LunarApi | null {
  const [m, setM] = useState<LunarModule | null>(() => mod ?? null);
  const wanted = locale !== 'ko-KR';
  useEffect(() => {
    if (m || !wanted) return;
    let alive = true;
    void ensure().then((x) => {
      if (alive && x) setM(x);
    });
    return () => {
      alive = false;
    };
  }, [m, wanted]);
  // 同一个模块、同一种语言时给同一个对象（月格的 useMemo 靠它不重算）
  return useMemo(() => (m && wanted ? apiOf(m, locale) : null), [m, locale, wanted]);
}

/** 测试用：清掉缓存，可换一个加载函数（模拟加载失败、慢加载） */
export function resetLunarForTest(loader: () => Promise<LunarModule> = defaultLoad): void {
  load = loader;
  mod = undefined;
  pending = null;
}
