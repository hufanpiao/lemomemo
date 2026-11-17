// 跨天日程（R-444）那几句话的翻译：event-span.ts 的 spanTextOn 给词条键 + 参数（SpanMsg），这里按公共词典 span.* 翻成字。
// 日历日清单、今天页共用这一份，不各写一套“持续 / 至 18:00 / 至 11月20日 18:00 / 第 2/3 天”
import { useCallback } from 'react';
import type { SpanMsg } from '../../../shared/logic/calendar/event-span.ts';
import { useT } from './useT.ts';

export function useSpanT(): (m: SpanMsg) => string {
  const t = useT();
  return useCallback(
    (m: SpanMsg): string => {
      switch (m.key) {
        case 'span.ongoing':
          return t(m.key, {});
        case 'span.until':
          return t(m.key, m.params);
        case 'span.untilDate':
          return t(m.key, m.params);
        case 'span.dayOf':
          return t(m.key, m.params);
      }
    },
    [t],
  );
}
