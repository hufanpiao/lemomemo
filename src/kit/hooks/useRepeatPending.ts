// 重复事项横幅的条数（FA-2 只读行界面；开发计划三之二）：日程、待办里还在用的（没删、没撤销）、带 repeat 的只读行——
// 4.1.0 的重复事项，4.0.x 只显示第一次；日历和今天页顶部据它出“有 N 条重复事项要新版本才能完整显示 · 更新”。
// 只在按需下载的横幅里用（kit 的 ReadonlyRowView），不进首屏（首屏预算 150 KB，FA-2 返工）
import { useMemo } from 'react';
import { isLiveRow } from '../../../shared/logic/calendar/cal-items.ts';
import type { Row } from '../../core/store.ts';
import { useCollection } from './useCollection.ts';
import { useReadonlyIds } from './useReadonly.ts';

type AnyRow = Row & Readonly<Record<string, unknown>>;

/** 只读、还在用、repeat 不为空的行数（纯函数，测试直接用） */
export function repeatPendingOf(rows: readonly AnyRow[], ro: ReadonlySet<string>): number {
  let n = 0;
  for (const r of rows) {
    if (!ro.has(r.id)) continue;
    const rep = r['repeat'];
    if (rep === undefined || rep === null) continue;
    if (!isLiveRow(r as Parameters<typeof isLiveRow>[0])) continue;
    n++;
  }
  return n;
}

export function useRepeatPending(): number {
  const events = useCollection<AnyRow>('events');
  const todos = useCollection<AnyRow>('todos');
  const roE = useReadonlyIds('events');
  const roT = useReadonlyIds('todos');
  return useMemo(() => repeatPendingOf(events, roE) + repeatPendingOf(todos, roT), [events, todos, roE, roT]);
}
