// 选中那天的黄历卡内容（R-431）：宜忌表和查表（shared/logic/anniv/lunar-huangli.ts）经 core/anniv-lib.ts 的 HUANGLI_LIB 按需加载
// • 只有中文界面、数据范围内（huangli-range.ts：公历 1901-01-20～2100-12-31）加载（同 useLunar：R-318、R-321，韩文界面月历不显示农历；韩文界面不下这一块）
// • 返回：内容（画卡片）；'wait'（加载中：DayList 先占好卡片的高度、标题行不写农历，加载完不跳，R-431 独立评审第 7 条）；
//   null（韩文界面、范围外、加载失败：不画卡片，标题行照旧写农历）
// • 日期格式不对（huangliOf 抛 bad_date）：记一行运行日志 `huangli bad_date`、当作没有卡片（独立评审第 6 条：留着 catch，
//   日期来自地址栏，抛出来会让整个日历页白掉；记日志是为了出现时查得到）
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { inHuangliRange } from '../../../../shared/logic/anniv/huangli-range.ts';
import { HUANGLI_LIB, type HuangliLib, type LazyLib } from '../../../core/anniv-lib.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';
import { rlog } from '../../../platform/run-log-api.ts';

export type Huangli = NonNullable<ReturnType<HuangliLib['huangliOf']>>;

/** lib 只给测试换（新建的 lazyLib 实例，各条用例互不串） */
export function useHuangli(date: DateStr | null, locale: UiLocale, lib: LazyLib<HuangliLib> = HUANGLI_LIB): Huangli | 'wait' | null {
  const want = date !== null && locale !== 'ko-KR' && inHuangliRange(date);
  const s = useLazyLib(lib, want);
  return useMemo(() => {
    if (s === 'loading') return 'wait';
    if (s !== 'ready' || date === null) return null;
    try {
      return lib.get().huangliOf(date);
    } catch {
      rlog('huangli bad_date');
      return null;
    }
  }, [s, date, lib]);
}
