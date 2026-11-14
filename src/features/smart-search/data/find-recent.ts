// “最近找过”（线框 s12 底部胶囊）：本机 meta 的 ui.find_recent，最近的在前、最多 RECENT_MAX 条、去重。
// 存在本机缓存的 meta（不同步、不进备份），跟着账号走：退出、换账号、被移除时随整库清掉（core/cache.ts 的 MetaMap）。
// 模块里那一份内存也跟着清（B4b-3 独立评审第 18 条：页面不重载，换账号后会看到上一个账号的词）：借 core/store 的集合 ui:find_recent
// 记“这份是当前账号读来的”，退出、换账号时 clearAllCollections 把它清空，这里收到通知就丢掉内存、下次重新读（同 readonlyIds 借集合）。
// 什么时候记：打开了一条结果（用户真的找到了要的东西），不是每打一个字都记。日志不记查询文字（A23），只在 meta 里存原文，和本机缓存里的标题同一级别。
// 写法同 todos/hooks/useSubtasks.ts 的收起状态（模块里一份、订阅、读写失败不提示）。纯 TS：不准 import React（A1）
import { getBoot } from '../../../core/boot.ts';
import { collection } from '../../../core/store.ts';

export const RECENT_MAX = 6;
const META_KEY = 'ui.find_recent';

let recent: readonly string[] = [];
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const fn of [...subs]) fn();
};
const owned = collection<{ id: string }>('ui:find_recent');
const own = (): void => {
  if (owned.getSnapshot().length === 0) owned.upsert([{ id: 'mine' }]);
};
owned.subscribe(() => {
  if (owned.getSnapshot().length > 0) return;
  loading = null;
  if (recent.length === 0) return;
  recent = [];
  emit();
});

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
      own();
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
  own();
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
  owned.clear();
}
