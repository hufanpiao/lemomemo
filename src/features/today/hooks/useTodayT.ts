// 功能 today 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale；外加时长、时区名两个按语言拼的小工具
// 顺带把“已过去”的拆分 splitPast（data 的纯函数）转给今天页：ui 不能直接碰 data；按界面留住的那份列表拆，不放进 useToday 的 model
// （原来另有一个只包一层 useMemo 的 useTodayPast.ts，B6 整合删了，今天页自己 useMemo）
// 还有“现在”卡浅色卡的暖心句 cheerText：句子在 ../i18n/cheer-zh.ts、cheer-ko.ts，按当天日期固定选哪一句（data 的 cheerIndex）
import { createT, type Locale } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { cheerIndex, splitDur } from '../data/today-model.ts';
import { cheerKo } from '../i18n/cheer-ko.ts';
import { cheerZh } from '../i18n/cheer-zh.ts';

export { splitPast } from '../data/today-model.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type TodayMsgKey = keyof typeof zh & string;

const tToday = createT({ zh, ko });

export const useTodayT = makeUseT({ zh, ko });

export function useLocale(): Locale {
  return useUi((s) => s.locale);
}

/** 今天的暖心句（负责人 11-14）：同一天同一句，第二天换一句 */
export function cheerText(today: DateStr, locale: Locale): string {
  const list = locale === 'ko-KR' ? cheerKo : cheerZh;
  return list[cheerIndex(today, list.length)] ?? '';
}

/** 时长：“1 小时 13 分”“13 分钟”“2 小时”（视觉稿 kDur） */
export function durText(min: number, locale: Locale): string {
  const { h, m } = splitDur(min);
  if (h && m) return tToday('dur.hm', { h, m }, locale);
  if (h) return tToday('dur.h', { h }, locale);
  return tToday('dur.m', { m }, locale);
}

/**
 * 时区的显示名（“14:00（韩国时间 15:00）”里那一段）：用 Intl 的 longGeneric（各语言自带，不另写城市表）；
 * 运行环境不支持就退回时区 id 的最后一段
 */
export function zoneName(tz: string, locale: Locale): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(0).find((p) => p.type === 'timeZoneName');
    if (part?.value) return part.value;
  } catch {
    // 不支持 longGeneric：退回 id
  }
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}
