// 设置 › 账号 › 最近的导出（R-256 ②）：打开设置页读一次；本页导出成功后（tick 变了）立刻读一次，
// 隔 RECENT_EXPORT_RECHECK_MS 再读一次（发信失败那行是服务器回响应以后 waitUntil 才写的，立刻读可能还没有）。
// 卸载或 tick 又变时清掉定时器。读失败、断网一律不显示（data/recent-exports.ts 回 hidden），不报错
import { useEffect, useState } from 'react';
import { RECENT_EXPORT_RECHECK_MS, type RecentExportResult, type RecentExportsApi } from '../data/recent-exports.ts';

export type { ExportEntry, RecentExportResult, RecentExportsApi } from '../data/recent-exports.ts';

/** loading：还在读（不显示）；其余同 RecentExportResult */
export type RecentExportState = { kind: 'loading' } | RecentExportResult;

export function useRecentExport(api: RecentExportsApi, tick: number): RecentExportState {
  const [state, setState] = useState<RecentExportState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const read = (): void => {
      api
        .list()
        .catch((): RecentExportResult => ({ kind: 'hidden' }))
        .then((r) => {
          if (live) setState(r);
        });
    };
    read();
    const again = tick > 0 ? setTimeout(read, RECENT_EXPORT_RECHECK_MS) : undefined;
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [api, tick]);
  return state;
}
