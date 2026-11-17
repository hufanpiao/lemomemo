// 功能 today 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale；外加时区名这个按语言拼的小工具（时长用 shared/i18n/fmt.ts 的 fmtDur，同步提示同一份）
// 顺带把“已过去”的拆分 splitPast（data 的纯函数）转给今天页：ui 不能直接碰 data；按界面留住的那份列表拆，不放进 useToday 的 model
// （原来另有一个只包一层 useMemo 的 useTodayPast.ts，B6 整合删了，今天页自己 useMemo）
// 还有“现在”卡浅色卡的暖心句 useCheerText：句子在 ../i18n/cheer-zh.ts、cheer-ko.ts，每小时换一句（负责人 11-17，pickCheer 用 data 的 cheerIndex 加钟点）；
// 句子按语言懒加载、只拉当前语言那份（两种语言各 50 句；静态打进来首屏预算会超，11-14 c43305a4 的 ci）
import { useEffect, useState } from 'react';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { cheerIndex } from '../data/today-model.ts';

export { eventSpanText, splitPast } from '../data/today-model.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type TodayMsgKey = keyof typeof zh & string;

export const useTodayT = makeUseT({ zh, ko });

export function useLocale(): Locale {
  return useUi((s) => s.locale);
}

/** 已经下载好的暖心句（按语言）；加载失败不接住，交给全局的未处理拒绝记运行日志，这一行留空 */
const cheerLists = new Map<Locale, readonly string[]>();
const loadCheer = (locale: Locale): Promise<readonly string[]> =>
  locale === 'ko-KR' ? import('../i18n/cheer-ko.ts').then((m) => m.cheerKo) : import('../i18n/cheer-zh.ts').then((m) => m.cheerZh);

/** 从一份句子里选这一小时那一句（负责人 11-17：“一个小时更换一条”）：同一小时同一句，下一个整点换下一句，到头绕回。
 *  从 1970-01-01 0 点起的第几个小时取余 = (天数 × 24 + 小时) mod n = (cheerIndex(天) × 24 + 小时) mod n；hour 是用户时区的钟点 0–23 */
export function pickCheer(list: readonly string[], today: DateStr, hour: number): string {
  const n = list.length;
  return n > 0 ? (list[(cheerIndex(today, n) * 24 + hour) % n] ?? '') : '';
}

/** 这一小时的暖心句；当前语言的句子还没下载好时回空串（NowCard 给空行留着行高，不跳） */
export function useCheerText(today: DateStr, hour: number, locale: Locale): string {
  const [, loaded] = useState(0);
  useEffect(() => {
    if (cheerLists.has(locale)) return undefined;
    let alive = true;
    void loadCheer(locale).then((list) => {
      cheerLists.set(locale, list);
      if (alive) loaded((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [locale]);
  const list = cheerLists.get(locale);
  return list ? pickCheer(list, today, hour) : '';
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
