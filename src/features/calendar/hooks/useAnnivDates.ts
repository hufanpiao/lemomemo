// 月历上的纪念日菱形（B5 S14；架构 5.4、5.12；线框 s3 图例“◆ 纪念日”）：这一页（42 格）里哪几天有纪念日
// • 推算用 shared/logic/anniv/next-date.ts 的 annivDatesIn（和纪念日页面、服务器同一份）；带农历表，经 kit 的 useAnnivLib 按需加载，不进入口（2.6）
// • 纪念日功能开关关着（本机缓存的 config 里 anniv 没开）、一条纪念日都没有：不加载、不画菱形
// • 加载中、加载失败（kit 记运行日志）：返回 undefined，月格照常显示、没有菱形
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { annivLib } from '../../../core/anniv-lib.ts';
import { useAnnivLib } from '../../../kit/hooks/useAnnivLib.ts';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

export function useAnnivDates(from: DateStr | null, to: DateStr | null, tz: string): ReadonlySet<DateStr> | undefined {
  const rows = useCollection<{ id: string }>('anniversaries');
  const want = from !== null && to !== null && rows.length > 0 && annivOn();
  const ready = useAnnivLib(want) === 'ready';
  return useMemo(() => (ready && from && to ? annivLib().annivDatesIn(rows, from, to, tz) : undefined), [ready, rows, from, to, tz]);
}
