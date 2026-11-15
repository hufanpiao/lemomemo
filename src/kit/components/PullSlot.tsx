// 下拉搜索的挂载位（R-437）：kit 的 usePullReveal 露出了才挂里面的东西（随手记、待办、日历页传 smart-search 懒加载的 PullSearch）。
// 三页共用这一处 Suspense + QuietBoundary：搜索那一块还没下载好时不占位，下载不到（离线冷启动）时安静不画，本页列表照常
import { Suspense, type ReactNode } from 'react';
import type { PullReveal } from '../hooks/usePullReveal.ts';
import { QuietBoundary } from './QuietBoundary.tsx';

export function PullSlot({ pull, children }: { pull: PullReveal; children: ReactNode }) {
  if (!pull.open) return null;
  return (
    <QuietBoundary name="pull-search">
      <Suspense fallback={null}>{children}</Suspense>
    </QuietBoundary>
  );
}
