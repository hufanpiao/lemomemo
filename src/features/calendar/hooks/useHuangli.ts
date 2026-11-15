// 选中那天的黄历卡内容（R-431）：宜忌表和查表（shared/logic/anniv/lunar-huangli.ts）经 core/anniv-lib.ts 的 HUANGLI_LIB 按需加载
// • 只有中文界面加载（同 useLunar：R-318、R-321，韩文界面月历不显示农历；韩文界面不下这一块、返回 null）
// • 加载中、加载失败、超出数据范围（公历 1901-01-20～2100-12-31 以外）：返回 null，清单照常显示、标题行照旧写农历
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { HUANGLI_LIB, type HuangliLib } from '../../../core/anniv-lib.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';

export type Huangli = NonNullable<ReturnType<HuangliLib['huangliOf']>>;

export function useHuangli(date: DateStr | null, locale: UiLocale): Huangli | null {
  const want = date !== null && locale !== 'ko-KR';
  const ready = useLazyLib(HUANGLI_LIB, want) === 'ready';
  return useMemo(() => {
    if (!ready || !want || date === null) return null;
    try {
      return HUANGLI_LIB.get().huangliOf(date);
    } catch {
      return null;
    }
  }, [ready, want, date]);
}
