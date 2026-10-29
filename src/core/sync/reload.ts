// 非主页（4.3b）重读本机库：主页写了本机库后广播 changed / reset，其余页面按 IndexedDB 重刷集合快照（真相在 IndexedDB）
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache, ServerRow } from '../cache.ts';
import { collection } from '../store.ts';

/** 按本机库重刷这几个集合：库里有 view 的写进去，集合里有、库里没有了的去掉；tables 为 null 时刷全部同步表 */
export async function reloadCollections(cache: Cache, tables: readonly string[] | null): Promise<void> {
  const list = (tables ?? cache.syncTables).filter((t) => cache.syncTables.includes(t));
  for (const table of list) {
    if (cache.isClosed()) return;
    const rows = await cache.allRows(table);
    const views = rows.flatMap((r) => (r.view ? [r.view] : []));
    const keep = new Set(views.map((v) => v.id));
    const c = collection<ServerRow>(table);
    const gone = c.getSnapshot().filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (gone.length) c.remove(gone);
    if (views.length) c.upsert(views);
  }
}
