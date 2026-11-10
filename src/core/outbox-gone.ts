// gone 项的收尾：outbox.resolveGone 的实现（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3；复审一 R2 ②③④）
// • 不进首屏：只有 core/write-gone.ts（按需下载）静态引它；ctx 经 outbox.ts 导出的 outboxCtx 取（首屏只多一次 WeakMap 登记）。
//   在首屏的文件里写 import('./outbox-gone.ts') 或给 Outbox 加方法，实测首屏 +72～100 B gzip（只剩 0.3 KB 余量）
// • restore：这条记录所有 failed + gone 的项，加上它们之后还没发出的 patch（跟随组），按 seq 合并成一项新的 pending patch，
//   （合并走 rows.mergePatch，同普通入队；恢复项的 deps 取各项并集）带 deleted_at: null（服务器行 undone 为 true 时再加 undone: false），再删掉这些项；drop：只删 gone 组，跟随组不动
// • 入队和删除在同一个写事务里：要么全成要么全不成；两个标签页同时点也只生效一次
// • 事务里重读到的项和事务外读的不一样（别的标签页处理过、又来了新的 gone、跟随组被发出去了）：抛 GoneChanged 让整个事务回滚，
//   回到事务外重读一次；第二次还不一样，返回 'nothing'
// • 合并后 undone === true（用户自己的修改就是撤销）：restore 拒收（OutboxRejectError('undone')），不复活两边都要删的记录
// 纯 TS：不准 import React 和任何功能（A1）
import type { CachedRow, ServerRow } from './cache.ts';
import { OUTBOX } from './cache-schema.ts';
import { bySeq, loadRowSchemas, OutboxCodeUnavailableError, OutboxRejectError, recKey, validateWrite, type WriteCode } from './outbox-logic.ts';
import type { OutboxItem, RecRef, ResolveGoneOptions, ResolveGoneReport } from './outbox-types.ts';
import { notify, rewriteRow } from './outbox-rows.ts';
import type { Ctx } from './outbox-send.ts';

/** 事务里读到的项和事务外的不一样：内部哨兵，只在这个文件里抛、在这个文件里接 */
class GoneChanged extends Error {
  override name = 'GoneChanged';
}

const isGone = (i: OutboxItem): boolean => i.state === 'failed' && i.error === 'gone';

/**
 * 这条记录要处理的项：gone 组，和（restore 时）gone 组之后还没发出的 patch（跟随组，复审一 R2 ②）。
 * 已发出的、在途的（sent 或 inflight）不动：回来照样走 gone 流程，最多再出一张卡
 */
function pick(mine: readonly OutboxItem[], mode: 'restore' | 'drop'): OutboxItem[] {
  const gone = mine.filter(isGone);
  if (gone.length === 0 || mode === 'drop') return gone;
  const lastGone = Math.max(...gone.map((i) => i.seq));
  return mine.filter((i) => isGone(i) || (i.seq > lastGone && i.op === 'patch' && i.state === 'pending' && !i.sent));
}

/** op_id 集合的指纹（按 seq 排好的项） */
const ids = (items: readonly OutboxItem[]): string => items.map((i) => i.op_id).join(',');

interface Plan {
  key: string;
  /** restore 才有：要入队的 patch 和它的 remind 标记 */
  patch?: Record<string, unknown>;
  remind?: boolean;
  rows?: WriteCode;
  deps?: RecRef[];
}

/** 第 1 步：事务外读、合并、校验（严格校验的代码按需加载，不能放进 IDB 事务里等）；没有 gone 项返回 null */
async function plan(ctx: Ctx, table: string, id: string, mode: 'restore' | 'drop', opts: ResolveGoneOptions): Promise<Plan | null> {
  const { row, mine } = await ctx.cache.tx([table, OUTBOX], 'readonly', async (t) => ({
    row: await t.get<CachedRow>(table, id),
    mine: (await t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', recKey(table, id))).sort(bySeq),
  }));
  const items = pick(mine, mode);
  if (items.length === 0) return null;
  if (mode === 'drop') return { key: ids(items) };
  let rows: WriteCode;
  try {
    rows = await loadRowSchemas();
  } catch (e) {
    throw new OutboxCodeUnavailableError(e);
  }
  // 按 seq 逐项用 rows.mergePatch 合并（代码审查 M1）：和普通入队同一套规则，前一项换了提醒、后一项是旧提醒的“知道了”时不把旧 notified_for 并进来（R4-L1）
  let merged: Record<string, unknown> = {};
  for (const i of items) merged = rows.mergePatch(merged, i.data);
  if (merged['undone'] === true) throw new OutboxRejectError('undone');   // R2 ④：给 gate 以外的调用方兜底
  const patch: Record<string, unknown> = { ...merged, deleted_at: null };
  if (row?.server?.['undone'] === true) patch['undone'] = false;   // M1
  if (ctx.isSuspended()) throw new OutboxRejectError('outbox_suspended');
  const bad = validateWrite({ table, id, op: 'patch', data: patch }, rows, ctx.opts.manifests);
  if (bad) throw new OutboxRejectError(bad);
  const base: ServerRow | null = row?.view ?? row?.server ?? null;
  const remind = opts.remindOf?.({ ...(base ?? {}), ...patch, id }, patch) === true;
  return { key: ids(items), patch, remind, rows, deps: depsOf(items, table, id) };
}

/** 恢复项的 deps（代码审查 M2）：gone 组和跟随组各项 deps 的并集，去掉这条记录自己、去重；不带的话带提醒整条提前发时可能排到它依赖的 insert 前面 */
function depsOf(items: readonly OutboxItem[], table: string, id: string): RecRef[] {
  const seen = new Map<string, RecRef>();
  for (const i of items) {
    for (const d of i.deps) {
      const k = recKey(d.table, d.id);
      if (k !== recKey(table, id) && !seen.has(k)) seen.set(k, { table: d.table, id: d.id });
    }
  }
  return [...seen.values()];
}

/** 第 2 步：写事务。重读的集合和 p.key 不一样就抛 GoneChanged（整个事务回滚） */
async function apply(ctx: Ctx, table: string, id: string, mode: 'restore' | 'drop', p: Plan, ts: number): Promise<{ view: ServerRow | null; opId: string | null }> {
  let view: ServerRow | null = null;
  let opId: string | null = null;
  await ctx.cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    const row = await t.get<CachedRow>(table, id);
    const all = await t.getAll<OutboxItem>(OUTBOX);
    const rec = recKey(table, id);
    const mine = all.filter((i) => i.rec === rec).sort(bySeq);
    const items = pick(mine, mode);
    if (items.length === 0 || ids(items) !== p.key) throw new GoneChanged();
    if (mode === 'restore') {
      if (!p.rows || !p.patch) throw new Error('resolveGone: restore plan missing');   // 不会走到：plan() 的 restore 分支总会给
      if (row?.ro) throw new OutboxRejectError('readonly_row');
      if (!row) throw new OutboxRejectError('row_missing');
      const gone = new Set(items.map((i) => i.op_id));
      const rest = mine.filter((i) => !gone.has(i.op_id));
      const item = p.rows.newItem(ctx, { table, id, op: 'patch', data: p.patch, remind: p.remind === true, deps: p.deps ?? [] }, row, rest, all, ts);
      await t.put(OUTBOX, item);
      opId = item.op_id;
    }
    for (const i of items) await t.delete(OUTBOX, i.op_id);
    view = await rewriteRow(t, table, id, row);
  });
  return { view, opId };
}

/** gone 项的收尾（说明见文件头；返回值、拒收码见 outbox-types.ts 的 ResolveGoneReport）。ctx 取 outboxCtx.get(outbox) */
export async function resolveGoneImpl(
  ctx: Ctx,
  table: string,
  id: string,
  mode: 'restore' | 'drop',
  opts: ResolveGoneOptions = {},
): Promise<ResolveGoneReport> {
  for (let round = 0; round < 2; round++) {
    if (ctx.isSuspended()) throw new OutboxRejectError('outbox_suspended');
    const p = await plan(ctx, table, id, mode, opts);
    if (!p) return { done: 'nothing', opId: null };
    const ts = ctx.now();
    let r: { view: ServerRow | null; opId: string | null };
    try {
      r = await apply(ctx, table, id, mode, p, ts);
    } catch (e) {
      if (e instanceof GoneChanged) continue;   // R2 ③：回滚了，重读一次
      throw e;
    }
    notify(table, [{ id, view: r.view }]);
    ctx.emit({ type: 'queue' });
    await ctx.refresh();
    return { done: mode === 'restore' ? 'restored' : 'dropped', opId: r.opId };
  }
  return { done: 'nothing', opId: null };
}
