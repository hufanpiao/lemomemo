// 月历上的纪念日菱形（B5 S14；架构 5.4、5.12；线框 s3 图例“◆ 纪念日”）：这一页（42 格）里哪几天有纪念日
// • 推算用 shared/logic/anniv/next-date.ts 的 annivDatesIn（和纪念日页面、服务器同一份）；它静态引农历表，这里按需 import()，不进入口（2.6）
// • 纪念日功能开关关着（本机缓存的 config 里 anniv 没开）、一条纪念日都没有：不加载、不画菱形
// • 加载中、加载失败：返回 undefined，月格照常显示、没有菱形；失败不重试
import { useEffect, useMemo, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type * as NextNs from '../../../../shared/logic/anniv/next-date.ts';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

type NextModule = typeof NextNs;
let mod: NextModule | null | undefined;
let pending: Promise<NextModule | null> | null = null;
const ensure = (): Promise<NextModule | null> =>
  (pending ??= import('../../../../shared/logic/anniv/next-date.ts').then(
    (m) => (mod = m),
    () => (mod = null),
  ));

export function useAnnivDates(from: DateStr | null, to: DateStr | null, tz: string): ReadonlySet<DateStr> | undefined {
  const rows = useCollection<{ id: string }>('anniversaries');
  const want = from !== null && to !== null && rows.length > 0 && annivOn();
  const [m, setM] = useState<NextModule | null>(() => mod ?? null);
  useEffect(() => {
    if (m || !want) return undefined;
    let alive = true;
    void ensure().then((x) => {
      if (alive && x) setM(x);
    });
    return () => {
      alive = false;
    };
  }, [m, want]);
  return useMemo(() => (m && want && from && to ? m.annivDatesIn(rows, from, to, tz) : undefined), [m, want, rows, from, to, tz]);
}
