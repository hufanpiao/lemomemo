// 日程在某一天那几句话的翻译（R-444）：event-span.ts 的 spanTextOn、untilMsg 给词条键 + 参数（SpanMsg），这里按公共词典 span.* 翻成字。
// 日历日清单和周视图、今天页、全屏提醒页共用这一份，不各写一套“全天 / 持续 / 至 18:00 / 至 11月20日 18:00 / 第 2/3 天”
import { useCallback } from 'react';
import type { SpanMsg } from '../../../shared/logic/calendar/event-span.ts';
import { useT } from './useT.ts';

export function useSpanT(): (m: SpanMsg) => string {
  const t = useT();
  // 键和参数一一对应由 SpanMsg 的联合类型保证；t 的参数类型按单个键推导，联合在这里对不上，按 never 放行（同 FullReminderPage 的 whenMsg）
  return useCallback((m: SpanMsg): string => t(m.key, m.params as never), [t]);
}
