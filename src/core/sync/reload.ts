// 非主页（4.3b）重读本机库：主页写了本机库后广播 changed / reset，其余页面按 IndexedDB 重刷集合快照（真相在 IndexedDB）
// 频道建好后的那次补读（B2 FA-6 推迟启动 M3）主页、非主页都跑
// 纯 TS：不准 import React 和任何功能（A1）
//
// 读库期间的并发写入（FA-6 推迟启动代码复审 N1）：allRows 要 await 一次 IndexedDB getAll，这期间本机写入（outbox.enqueue）
// 或引擎拉取（applyServerRows）可能先提交、再 notify 把新行推进内存。所以读库之前先记下内存里每一行的对象引用，读完以后：
// • 只删“读之前就在、读完还是同一个对象、库里没有了”的行；
// • 只写入“内存里那一行还是读之前那个对象（或读之前、读完都没有）”的行。
// 读的期间被动过（新增、改过、删掉）的行一律以内存为准：它们比这份库快照新。
// 换账号闸（FA6-r3-low N3）：逐表 await 的期间可能设了闸（watchAccount 清空了内存、正在清库），stop() 为 true 就不再读下一张、
// 也不把刚读到的这张写回内存（每张表开读前、读完后各看一次）
import type { Cache, ServerRow } from '../cache.ts';
import { collection, readonlyIds } from '../store.ts';

/**
 * 按本机库重刷这几个集合：库里有 view 的写进去，集合里有、库里没有了的去掉；tables 为 null 时刷全部同步表。
 * stop：调用方的换账号闸（sync-wiring 传 () => boot.switching），为 true 时立刻停下、不再动内存
 */
export async function reloadCollections(cache: Cache, tables: readonly string[] | null, stop: () => boolean = () => false): Promise<void> {
  const list = (tables ?? cache.syncTables).filter((t) => cache.syncTables.includes(t));
  for (const table of list) {
    if (cache.isClosed() || stop()) return;
    const c = collection<ServerRow>(table);
    const before = new Map(c.getSnapshot().map((r) => [r.id, r] as const));
    const rows = await cache.allRows(table);
    if (stop()) return;
    const views = rows.flatMap((r) => (r.view ? [r.view] : []));
    const keep = new Set(views.map((v) => v.id));
    const roOf = new Map(rows.map((r) => [r.id, r.ro === true] as const));
    /** 读库期间这一行没被动过：现在的对象就是读之前那个（都没有也算） */
    const untouched = (id: string): boolean => c.get(id) === before.get(id);
    const gone = [...before.keys()].filter((id) => !keep.has(id) && before.get(id) !== undefined && untouched(id));
    const fresh = views.filter((v) => untouched(v.id));
    // 只读标记（FA-2 只读行界面）跟着同一份快照走，先于集合
    const ro = readonlyIds(table);
    if (gone.length) ro.remove(gone);
    if (fresh.length) ro.set(fresh.map((v) => ({ id: v.id, ro: roOf.get(v.id) === true })));
    if (gone.length) c.remove(gone);
    if (fresh.length) c.upsert(fresh);
  }
}
