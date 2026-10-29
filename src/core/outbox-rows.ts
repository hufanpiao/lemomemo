// 离线队列写同步仓的部分：rebase 后写回 view、通知内存集合、接服务器来的行（outbox.ts 用）；R-229 空壳清明文
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
  if (row?.shell_rev !== undefined) {
    next.shell_rev = row.shell_rev;
    next.shell_inclusive = row.shell_inclusive === true;
  }
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

/** 丢掉空壳那一行的队列项时记的日志（只有表名、id、条数，不记内容） */
export interface ShellDropLog {
  act: 'outbox_vault_shell_drop';
  coll: string;
  id: string;
  dropped: number;
}

export interface ApplyServerOptions {
  log?: ((e: ShellDropLog) => void) | undefined;
}

/** applyServer 的结果：skipped 是这次没收的行（比本机旧，或不高于空壳门槛 shell_rev）；K7 据此不动它们的待补拉 */
export interface ApplyServerReport {
  skipped: string[];
}

const revOf = (r: ServerRow | null | undefined): number | null => {
  const v = r?.['rev'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** 门槛：minRev 来的含等于；本机旧 rev、旧门槛（按它自己的含不含）补的严格大于；同一个 rev 时含等于的优先（来自原始行） */
function shellGate(minRev: number | null | undefined, old: CachedRow | undefined): { rev: number; inclusive: boolean } {
  const cands: { rev: number; inclusive: boolean }[] = [];
  if (typeof minRev === 'number') cands.push({ rev: minRev, inclusive: true });
  const local = revOf(old?.server);
  if (local !== null) cands.push({ rev: local, inclusive: false });
  if (old?.shell_rev !== undefined) cands.push({ rev: old.shell_rev, inclusive: old.shell_inclusive === true });
  let best = { rev: 0, inclusive: false };   // 都取不到：0、严格大于（之后只收有 rev 的行）
  for (const c of cands) if (c.rev > best.rev || (c.rev === best.rev && c.inclusive)) best = c;
  return best;
}

/** 过没过空壳门槛 */
function passesShell(old: CachedRow, newRev: number | null): boolean {
  if (old.shell_rev === undefined) return true;
  if (newRev === null) return false;
  return old.shell_inclusive === true ? newRev >= old.shell_rev : newRev > old.shell_rev;
}

/**
 * 服务器来的行：更新 server，叠上还没确认的项得到 view；比本机旧的 rev 忽略（outbox.applyServer）。
 * R-229 空壳（input.shell === true，K7 宽容读取给出）：
 *   - 本机没有这一行：不建空壳，id 进 skipped（同一个读写事务里判断，没有并发窗口；K8 直接走 createParseRows＋applyServer 也一样）
 *   - 晚到的空壳（minRev 比本机已收正常行的 rev 小）：跳过，进 skipped，不盖正常行、不删队列
 *   - 本机有：明文必须立即清出本机——丢掉这一行在队列里的全部项（含 inflight、failed；inflight 的 ack / fail 回来时找不到项，什么也不做），
 *     server、view 都只剩空壳、只读，并记门槛（shellGate）；
 *   之后这一行只收过了门槛的行（passesShell；没有 rev 的一律不收），被拒的行不改本机（ro 照旧），id 进 skipped；
 *   收进来的正常行清掉门槛
 */
export async function applyServerRows(
  cache: Cache,
  table: string,
  rows: readonly ServerRowInput[],
  opts: ApplyServerOptions = {},
): Promise<ApplyServerReport> {
  const report: ApplyServerReport = { skipped: [] };
  if (rows.length === 0) return report;
  const views: { id: string; view: ServerRow | null }[] = [];
  const logs: ShellDropLog[] = [];
  await cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    for (const input of rows) {
      const { row, ro } = input;
      const old = await t.get<CachedRow>(table, row.id);
      if (input.shell === true) {
        if (old === undefined) {
          report.skipped.push(row.id);   // 本机原来没有这一行：不建空壳（只进待补拉，由 K7 记日志）
          continue;
        }
        // 晚到的空壳（K6 复审建议 1）：本机已经收了比它新的正常行（minRev < 本机 rev），这个坏行是旧版本，跳过，不盖正常行、不删队列。
        // minRev 为 null（原始行没有可用的 rev）时分不出新旧，按隐私优先照样建空壳
        const localRev = revOf(old.server);
        if (old.shell_rev === undefined && typeof input.minRev === 'number' && localRev !== null && input.minRev < localRev) {
          report.skipped.push(row.id);
          continue;
        }
        const gate = shellGate(input.minRev, old);
        const items = await t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', recKey(table, row.id));
        for (const i of items) await t.delete(OUTBOX, i.op_id);
        await t.put(table, { id: row.id, server: row, view: row, ro: true, shell_rev: gate.rev, shell_inclusive: gate.inclusive } satisfies CachedRow);
        views.push({ id: row.id, view: row });
        if (items.length) logs.push({ act: 'outbox_vault_shell_drop', coll: table, id: row.id, dropped: items.length });
        continue;
      }
      const newRev = revOf(row);
      if (old && !passesShell(old, newRev)) {
        report.skipped.push(row.id);   // 没过空壳门槛：晚到的旧行，不能把明文带回来
        continue;
      }
      const oldRev = revOf(old?.server);
      if (oldRev !== null && newRev !== null && newRev < oldRev) {
        report.skipped.push(row.id);   // 比本机旧（Realtime 晚到）
        continue;
      }
      const base: CachedRow = { id: row.id, server: row, view: old?.view ?? null };
      if (ro) base.ro = true;
      const own = (old?.own_revs ?? []).filter((r) => newRev === null || r > newRev);
      if (own.length) base.own_revs = own;
      views.push({ id: row.id, view: await rewriteRow(t, table, row.id, base) });
    }
  });
  notify(table, views);
  for (const e of logs) opts.log?.(e);
  return report;
}
