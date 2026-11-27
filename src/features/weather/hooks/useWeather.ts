// 天气胶囊、逐时半屏、设置 › 天气 拿状态的地方：订 data/weather-state.ts 那一份；挂上、回到前台、页面开着每过一刻钟时
// 缓存超过 30 分钟才再取（weatherState.refreshIfOld，同时只跑一次）；“现在”按整分钟走（kit useMinuteNow），过整点时提示跟着换
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { fmtTime } from '../../../../shared/i18n/fmt.ts';
import { cityName } from '../../../../shared/logic/weather/cities.ts';
import { airWorst, dayOf, daysAfterToday, nextHours, restOfToday, tipHours, weatherTip, type WxAir, type WxTip } from '../../../../shared/logic/weather/tips.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { searchCity, weatherState, type WxView } from '../data/weather-state.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export const useWeatherT = makeUseT({ zh, ko });
export { searchCity, weatherState };
export type { WxView };

/** 天气这边只分中韩两种语言（城市搜索、内置城市名） */
export const useWxLang = (): 'zh' | 'ko' => (useUi((s) => s.locale) === 'ko-KR' ? 'ko' : 'zh');

/** 手动选的城市的显示名：内置常用城市跟着界面语言变（shared/logic/weather/cities.ts），别的用搜索时那种语言的名字 */
export function useCityName(): (place: { key?: string | undefined; name: string }) => string {
  const lang = useWxLang();
  return (place) => cityName(place, lang);
}

/** 提示的字（雨、雪带整点） */
export function useTipText(): (tip: WxTip) => string {
  const t = useWeatherT();
  return (tip) => (tip.kind === 'rain' ? t('weather.tip.rain', { h: tip.hour }) : tip.kind === 'snow' ? t('weather.tip.snow', { h: tip.hour }) : t(`weather.tip.${tip.kind}`, {}));
}

/** 半屏逐时列几个整点 */
export const SHEET_HOURS = 12;

export function useWeatherView(): WxView {
  const view = useSyncExternalStore(weatherState.subscribe, weatherState.get, weatherState.get);
  useEffect(() => {
    weatherState.refreshIfOld();
    return weatherState.watchForeground();
  }, []);
  return view;
}

/** 有天气时算好的几样（提示、今天、接下来几个整点、要标出的整点）；没有为 null */
export function useWeatherNow(view: WxView): {
  tip: WxTip;
  hi: number;
  lo: number;
  uv: number;
  hours: ReturnType<typeof nextHours>;
  marked: ReadonlySet<string>;
  /** 剩下时段里空气最差的那个整点（胶囊“戴好口罩”同一个判断）；没有空气数据为 null */
  air: WxAir | null;
  week: ReturnType<typeof daysAfterToday>;
} | null {
  const now = useMinuteNow();
  // 每 15 分钟、换了包时重算（每分钟一跳，同一个整点结果一样；按 15 分钟切，半点、45 分时区的整点也赶得上）
  const hourKey = Math.floor(now / 900_000);
  // 页面一直开着（宽屏开一整天）：每过一刻钟看一眼，缓存超过 30 分钟就再取
  useEffect(() => weatherState.refreshIfOld(), [hourKey]);
  return useMemo(() => {
    if (view.kind !== 'show') return null;
    const tip = weatherTip(view.pack, now);
    const today = dayOf(view.pack, now);
    if (!tip || !today) return null;
    const rest = restOfToday(view.pack, now);
    return {
      tip,
      hi: today.hi,
      lo: today.lo,
      uv: today.uv,
      hours: nextHours(view.pack, now, SHEET_HOURS),
      marked: tipHours(view.pack, now, tip),
      air: airWorst(rest),
      week: daysAfterToday(view.pack, now),
    };
    // now 只经 hourKey 起作用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hourKey]);
}

/** 摄氏度取整（-0 写成 0） */
export const deg = (n: number): number => {
  const r = Math.round(n);
  return Object.is(r, -0) ? 0 : r;
};

/** 取到时刻的“14:20”（用户的时区，同 App 别处） */
export const hhmm = (ms: number): string => fmtTime(ms, currentTz());
