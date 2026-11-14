// “最近找过”（线框 s12 底部胶囊）：本机 meta 的 ui.find_recent，最近的在前、最多 RECENT_MAX 条、去重。
// 存在本机缓存的 meta（不同步、不进备份），跟着账号走：退出、换账号、被移除时随整库清掉（core/cache.ts 的 MetaMap）。
// 什么时候记：打开了一条结果（用户真的找到了要的东西），不是每打一个字都记。日志不记查询文字（A23），只在 meta 里存原文，和本机缓存里的标题同一级别。
// 写法同 todos/hooks/useSubtasks.ts 的收起状态（模块里一份、订阅、读写失败不提示）。纯 TS：不准 import React（A1）
import { getBoot } from '../../../core/boot.ts';

export const RECENT_MAX = 6;
const META_KEY = 'ui.find_recent';

let recent: readonly string[] = [];
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const fn of [...subs]) fn();
};

function openCache() {
  const c = getBoot()?.cache;
  return c && !c.isClosed() ? c : null;
}

/** 读一次（重复调没关系）；还没启动好下次再读 */
export function loadRecent(): Promise<void> {
  loading ??= (async () => {
    try {
      const c = openCache();
      if (!c) {
        loading = null;
        return;
      }
      const v = await c.getMeta(META_KEY);
      if (Array.isArray(v)) {
        recent = v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX);
        emit();
      }
    } catch {
      loading = null;
    }
  })();
  return loading;
}

/** 新的放最前、去掉一样的（大小写、空白不同也算一样）、超过上限丢最旧的 */
export function pushRecent(list: readonly string[], q: string): string[] {
  const t = q.trim();
  if (t === '') return [...list];
  const same = (x: string) => x.trim().toLowerCase() === t.toLowerCase();
  return [t, ...list.filter((x) => !same(x))].slice(0, RECENT_MAX);
}

export function addRecent(q: string): void {
  const next = pushRecent(recent, q);
  if (next.length === recent.length && next.every((x, i) => x === recent[i])) return;
  recent = next;
  emit();
  void openCache()?.setMeta(META_KEY, recent).catch(() => undefined);
}

export const recentSnapshot = (): readonly string[] => recent;
export function subscribeRecent(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 测试用 */
export function resetRecentForTest(): void {
  recent = [];
  loading = null;
}
