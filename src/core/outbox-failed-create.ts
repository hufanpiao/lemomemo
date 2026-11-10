// 新建永久失败、码不能重试时的两个出路（R-378，接手清单 OUTBOX-failed-create-drops-edits；负责人 11-10 定）：
// • copy = “另存为新的一条”：换新 id，把失败的 insert 和它后面还没发的修改按 seq 用 rows.mergePatch 合成一个新的 insert
//   （提醒标记取各项的“或”），旧记录的项和本机行删掉。合成后已删除（deleted_at）或撤销（undone）的，不另存，按 drop 处理。
//   有别的记录依赖它（deps）时拒收（has_dependents）：依赖项的数据里指着旧 id，另存过去也对不上，只能放弃
// • drop = “放弃”：删掉这条记录的全部项和本机行，依赖它的项一起删（cancelDependents，同 insert 被撤销抵消）
// • settings 不准另存，copy 按 drop 处理：它按 (user_id,key) 唯一，换 id 照样 23505（代码审查必改 1）
// • 在途（inflight）的不动：有在途项返回 nothing（发送结果回来再说）
// • 不进首屏：只有 core/write-failed-create.ts（按需下载）静态引它；ctx 经 outbox.ts 导出的 outboxCtx 取（同 outbox-gone.ts）
// 纯 TS：不准 import React 和任何功能（A1）
import type { CachedRow } from './cache.ts';
import { OUTBOX } from './cache-schema.ts';
import { bySeq, loadRowSchemas, OutboxCodeUnavailableError, OutboxRejectError, recKey, validateWrite, type WriteCode } from './outbox-logic.ts';
import type { OutboxItem } from './outbox-types.ts';
import { cancelDependents, notify, rewriteRow } from './outbox-rows.ts';
import type { Ctx } from './outbox-send.ts';

export interface FailedCreateReport {
  done: 'copied' | 'dropped' | 'nothing';
  /** copy 成了：新记录的 id */
  id: string | null;
}

const isFailedInsert = (i: OutboxItem): boolean => i.state === 'failed' && i.op === 'insert';
/** 两次读到的项是不是一样：后写的 patch 会合并进已排队的那一项（op_id 不变、data 变了），所以连 data、state、deps 一起比 */
const key = (items: readonly OutboxItem[]): string => JSON.stringify(items.map((i) => [i.op_id, i.state, i.data, i.deps]));

/** 合成 copy 的新 insert 数据；已删除、已撤销的返回 null（按 drop 处理） */
function mergedData(rows: WriteCode, mine: readonly OutboxItem[], newId: string): Record<string, unknown> | null {
  let data: Record<string, unknown> = {};
  for (const i of mine) data = rows.mergePatch(data, i.data);
  if ((data['deleted_at'] ?? null) !== null || data['undone'] === true) return null;
  const { deleted_at: _d, undone: _u, ...rest } = data;
  return { ...rest, id: newId };
}

export async function resolveFailedCreateImpl(
  ctx: Ctx,
  table: string,
  id: string,
  mode: 'copy' | 'drop',
  newId: string,
): Promise<FailedCreateReport> {
  if (ctx.isSuspended()) throw new OutboxRejectError('outbox_suspended');
  const rec = recKey(table, id);
  // 第 1 步：事务外读、合成、校验（严格校验的代码按需加载，不能放进 IDB 事务里等）
  const before = (await ctx.cache.tx([OUTBOX], 'readonly', (t) => t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', rec))).sort(bySeq);
  if (!before.some(isFailedInsert) || before.some((i) => i.state === 'inflight')) return { done: 'nothing', id: null };
  let data: Record<string, unknown> | null = null;
  let rows: WriteCode | null = null;
  if (mode === 'copy' && table !== 'settings') {
    try {
      rows = await loadRowSchemas();
    } catch (e) {
      throw new OutboxCodeUnavailableError(e);
    }
    data = mergedData(rows, before, newId);
    if (data) {
      const bad = validateWrite({ table, id: newId, op: 'insert', data }, rows, ctx.opts.manifests);
      if (bad) throw new OutboxRejectError(bad);
    }
  }
  const copy = rows !== null && data !== null;
  const remind = before.some((i) => i.remind);
  // 新 insert 带上原各项 deps 的并集（去重）：原来要等的上游记录照样先发
  const deps = [...new Map(before.flatMap((i) => i.deps).map((d) => [recKey(d.table, d.id), { table: d.table, id: d.id }])).values()];
  const ts = ctx.now();
  const scope = [...new Set([table, ...ctx.cache.syncTables])];
  const views: { table: string; id: string; view: CachedRow['view'] }[] = [];
  let done = 'nothing' as FailedCreateReport['done'];   // 事务回调里改（as：别让 TS 把它收窄成字面量 'nothing'）
  // 第 2 步：写事务。重读到的项和第 1 步不一样（别的标签页处理过、又写了新的修改）就什么也不做
  await ctx.cache.tx([...scope, OUTBOX], 'readwrite', async (t) => {
    const all = await t.getAll<OutboxItem>(OUTBOX);
    const mine = all.filter((i) => i.rec === rec).sort(bySeq);
    if (key(mine) !== key(before)) return;
    if (copy && all.some((i) => i.rec !== rec && i.deps.some((d) => recKey(d.table, d.id) === rec))) throw new OutboxRejectError('has_dependents');
    for (const i of mine) await t.delete(OUTBOX, i.op_id);
    views.push({ table, id, view: await rewriteRow(t, table, id, await t.get<CachedRow>(table, id)) });
    if (copy && rows && data) {
      const item = rows.newItem(ctx, { table, id: newId, op: 'insert', data, remind, deps }, undefined, [], all, ts);
      await t.put(OUTBOX, item);
      views.push({ table, id: newId, view: await rewriteRow(t, table, newId, undefined) });
      done = 'copied';
    } else {
      views.push(...(await cancelDependents(t, rec, scope)));
      done = 'dropped';
    }
  });
  for (const v of views) notify(v.table, [{ id: v.id, view: v.view }]);
  if (done !== 'nothing') {
    ctx.emit({ type: 'queue' });   // 队列变了：提醒主页马上发（同 touched，代码审查必改 2）
    await ctx.refresh();
  }
  return { done, id: done === 'copied' ? newId : null };
}
