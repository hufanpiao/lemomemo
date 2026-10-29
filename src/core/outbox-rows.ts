// 离线队列写同步仓的部分：rebase 后写回 view、通知内存集合、接服务器来的行（outbox.ts 用）
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache, CachedRow, CacheTx, ServerRow } from './cache.ts';
import { OUTBOX } from './cache-schema.ts';
import { rebaseView, recKey } from './outbox-logic.ts';
import type { OutboxItem, ServerRowInput } from './outbox-types.ts';
import { collection } from './store.ts';

/** 把 view 推给内存里的集合 */
export function notify(table: string, rows: readonly { id: string; view: ServerRow | null }[]): void {
  const c = collection<ServerRow>(table);
  const up = rows.flatMap((r) => (r.view ? [r.view] : []));
  const gone = rows.filter((r) => r.view === null).map((r) => r.id);
  if (up.length) c.upsert(up);
  if (gone.length) c.remove(gone);
}

/** 事务里：按 server 和这条记录剩下的项重算 view，写回（两者都没有就删行）；返回新 view */
export async function rewriteRow(t: CacheTx, table: string, id: string, row: CachedRow | undefined): Promise<ServerRow | null> {
  const items = await t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', recKey(table, id));
  const server = row?.server ?? null;
  const view = rebaseView(server, items);
  if (!server && !view) {
    if (row) await t.delete(table, id);
    return null;
  }
  const next: CachedRow = { id, server, view };
  if (row?.ro) next.ro = true;
  if (row?.own_revs?.length) next.own_revs = [...row.own_revs];
  await t.put(table, next);
  return view;
}

/**
 * insert 被撤销抵消以后（K6 审查 L10）：依赖这条记录（deps）的项也抵消——
 * 依赖项是 insert 的，那条记录的项整条删掉，并继续抵消依赖它的；是 patch 的，只删这一项。
 * 只处理 tables 里的表（事务范围），返回改过 view 的行，调用方通知集合
 */
export async function cancelDependents(
  t: CacheTx,
  rec: string,
  tables: readonly string[],
): Promise<{ table: string; id: string; view: ServerRow | null }[]> {
  const gone = new Set([rec]);
  const touched = new Map<string, { table: string; id: string }>();
  for (let changed = true; changed; ) {
    changed = false;
    const all = await t.getAll<OutboxItem>(OUTBOX);
    for (const i of all) {
      if (i.state === 'inflight' || !i.deps.some((d) => gone.has(recKey(d.table, d.id)))) continue;
      // 正在发送（inflight）的项一律不动（N6）：结果由 ack / fail 处理
      const whole = (i.op === 'insert' ? all.filter((x) => x.rec === i.rec) : [i]).filter((x) => x.state !== 'inflight');
      for (const x of whole) await t.delete(OUTBOX, x.op_id);
      if (i.op === 'insert') gone.add(i.rec);
      touched.set(i.rec, { table: i.table, id: i.id });
      changed = true;
      break;   // 队列变了，重读
    }
  }
  const out: { table: string; id: string; view: ServerRow | null }[] = [];
  for (const { table, id } of touched.values()) {
    if (!tables.includes(table)) continue;
    out.push({ table, id, view: await rewriteRow(t, table, id, await t.get<CachedRow>(table, id)) });
  }
  return out;
}

/** 服务器来的行：更新 server，叠上还没确认的项得到 view；比本机旧的 rev 忽略（outbox.applyServer） */
export async function applyServerRows(cache: Cache, table: string, rows: readonly ServerRowInput[]): Promise<void> {
  if (rows.length === 0) return;
  const views: { id: string; view: ServerRow | null }[] = [];
  await cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    for (const { row, ro } of rows) {
      const old = await t.get<CachedRow>(table, row.id);
      const oldRev = old?.server?.['rev'];
      const newRev = row['rev'];
      if (typeof oldRev === 'number' && typeof newRev === 'number' && newRev < oldRev) continue;   // 比本机旧（Realtime 晚到）
      const base: CachedRow = { id: row.id, server: row, view: old?.view ?? null };
      if (ro) base.ro = true;
      const own = (old?.own_revs ?? []).filter((r) => typeof newRev !== 'number' || r > newRev);
      if (own.length) base.own_revs = own;
      views.push({ id: row.id, view: await rewriteRow(t, table, row.id, base) });
    }
  });
  notify(table, views);
}
