// 离线写入队列（架构 4.2、0.27 第 1 点、第七轮 S1）
// • 写入就是入队：同一个 IndexedDB 事务里改同步仓的 view、写 outbox，入队成功界面就更新（core/store 的集合跟着通知）
// • 删除和撤销都是 patch（deleted_at、undone），没有硬删除
// • 同一条记录还没发出的 patch 合并成一个（base_rev 取最早那个）；正在发送的那一项不参与合并；insert 之后马上撤销的两项抵消
// • 发送顺序：全局先进先出，带提醒的记录整条提前；同一条记录的项不颠倒；有依赖（deps）的不跑到被依赖的前面
// • 收到确认后推进后面 patch 的 base_rev / own_revs（S1）
// • 闸（suspend，换账号、被移除时设上）：之后 enqueue 拒收（outbox_suspended）、next 返回 null，ack、fail、applyServer 等一律不做
// • 失败分五类：upgrade（426 / upgrade_required：不回滚、不计 tries、整个队列暂停）、auth（401：刷新后重发，不计 tries）、
//   transient（断网、5xx、429：退避 2、4、8 秒……最长 5 分钟）、permanent（其他 4xx、校验失败：进“发送失败”区并回滚 view）、
//   drop（vault_required、settings_key_immutable、not_found：丢掉这一项、不重试，调用方整表重拉、写 logs outbox_rejected）；
//   另有 removed（session_revoked、account_disabled：被移除，设闸、发 removed 事件，调用方清空本机回登录页）
// • insert 被撤销抵消时，依赖它的项（deps）一起抵消；依赖它的是 insert 的，那条记录整条丢掉（再往下传）
// 网络请求不在这里：K8（同步）调 next() 取一项、发出去，再调 ack() 或 fail()
// 类型和接口在 outbox-types.ts，纯函数在 outbox-logic.ts，这里一并转出
// 隐私记的明文不进这里（A18）
// 纯 TS：不准 import React 和任何功能（A1）
import { buildInfo } from '../platform/env.ts';
import type { Cache, CachedRow, CacheTx, ServerRow } from './cache.ts';
import { OUTBOX } from './cache-schema.ts';
import { bySeq, OutboxRejectError, recKey, sendOrder, validateWrite } from './outbox-logic.ts';
import { migrateOutboxItem, OUTBOX_V, outboxMigrations } from './outbox-migrations.ts';
import type { EnqueueInput, Outbox, OutboxBootReport, OutboxEvent, OutboxItem, OutboxStatus, OutboxOptions } from './outbox-types.ts';
import { applyServerRows, cancelDependents, notify, rewriteRow } from './outbox-rows.ts';
import { ackImpl, failImpl, type Ctx } from './outbox-send.ts';

export * from './outbox-logic.ts';
export * from './outbox-types.ts';
export { drainPendingActions, PENDING_ACTION_TTL_MS } from './pending-actions.ts';

const EMPTY_SET: ReadonlySet<string> = new Set();

async function bootImpl(ctx: Ctx): Promise<OutboxBootReport> {
  const report: OutboxBootReport = { migrated: 0, future: 0, stuck: 0, reset: 0, paused: null };
  await ctx.cache.tx([OUTBOX], 'readwrite', async (t) => {
    for (const r of await t.getAll<Record<string, unknown>>(OUTBOX)) {
      const m = migrateOutboxItem(r, ctx.opts.migrations ?? outboxMigrations, ctx.currentV);
      if (m.kind !== 'ok') {
        report[m.kind]++;
        continue;
      }
      const item = m.item as unknown as OutboxItem;
      let dirty = m.changed;
      if (m.changed) report.migrated++;
      if (item.state === 'inflight') {
        item.state = 'pending';
        item.sent = true;   // 上次可能已上服务器：不再合并新修改（K8 三审，K6 遗留）
        report.reset++;
        dirty = true;
      }
      if (dirty) await t.put(OUTBOX, item);
    }
  });
  const pause = await ctx.cache.getMeta('outbox_pause');
  if (pause && pause.app !== ctx.appVersion) await ctx.cache.deleteMeta('outbox_pause');
  else report.paused = pause ?? null;
  await ctx.refresh();
  return report;
}

async function enqueueImpl(ctx: Ctx, input: EnqueueInput): Promise<OutboxItem | null> {
  if (ctx.isSuspended()) throw new OutboxRejectError('outbox_suspended');
  const bad = validateWrite(input, ctx.opts.manifests);
  if (bad) throw new OutboxRejectError(bad);
  const { table, id, op } = input;
  const rec = recKey(table, id);
  const ts = ctx.now();
  let result: OutboxItem | null = null;
  let view: ServerRow | null = null;
  let cancelled: { table: string; id: string; view: ServerRow | null }[] = [];
  // 撤销可能抵消掉 insert，依赖它的项（别的表）也要一起抵消：事务范围放宽到所有同步仓
  const undo = op === 'patch' && input.data['undone'] === true;
  const scope = undo ? [...new Set([table, ...ctx.cache.syncTables])] : [table];
  await ctx.cache.tx([...scope, OUTBOX], 'readwrite', async (t) => {
    const row = await t.get<CachedRow>(table, id);
    if (row?.ro) throw new OutboxRejectError('readonly_row');
    if (op === 'insert' && row?.view) throw new OutboxRejectError('row_exists');
    if (op === 'patch' && !row?.view) throw new OutboxRejectError('row_missing');
    const all = await t.getAll<OutboxItem>(OUTBOX);
    const mine = all.filter((i) => i.rec === rec).sort(bySeq);

    // insert 之后马上撤销：两项一起抵消，不发送
    if (undo && mine[0]?.op === 'insert' && mine.every((i) => i.state === 'pending' && !i.sent)) {
      for (const i of mine) await t.delete(OUTBOX, i.op_id);
      view = await rewriteRow(t, table, id, row);
      cancelled = await cancelDependents(t, rec, scope);   // L10：依赖它的项一起抵消
      return;
    }

    // 还没发出的 patch 合并（inflight 的、发出去过的不参与：重发同一 op_id 会被服务器当重复，新修改就丢了；带依赖的新项不合并，免得被提前）
    const last = mine[mine.length - 1];
    if (op === 'patch' && last?.op === 'patch' && last.state === 'pending' && !last.sent && last.v === ctx.currentV && !input.deps?.length) {
      result = { ...last, data: { ...last.data, ...input.data }, remind: last.remind || input.remind === true, client_ts: ts };
    } else {
      const serverRev = row?.server?.['rev'];
      const afterInsert = mine.some((i) => i.op === 'insert');
      result = {
        op_id: ctx.newOpId(),
        table,
        id,
        rec,
        op,
        data: { ...input.data },
        base_rev: op === 'patch' && !afterInsert && typeof serverRev === 'number' ? serverRev : null,
        own_revs: op === 'patch' && !afterInsert ? [...(row?.own_revs ?? [])] : [],
        client_ts: ts,
        tries: 0,
        next_at: 0,
        state: 'pending',
        v: ctx.currentV,
        app: ctx.appVersion,
        seq: all.reduce((m, i) => Math.max(m, i.seq), 0) + 1,
        remind: input.remind === true,
        deps: (input.deps ?? []).map((d) => ({ table: d.table, id: d.id })),
        error: null,
      };
    }
    await t.put(OUTBOX, result);
    view = await rewriteRow(t, table, id, row);
  });
  notify(table, [{ id, view }]);
  for (const c of cancelled) notify(c.table, [c]);
  await ctx.refresh();
  return result;
}

/** 重算若干条记录的 view（items 改过之后）；write 在同一个事务里先改队列 */
async function rewriteRecs(
  ctx: Ctx,
  table: string,
  ids: readonly string[],
  write: (t: CacheTx) => Promise<void>,
): Promise<void> {
  if (ctx.isSuspended()) return;
  const views: { id: string; view: ServerRow | null }[] = [];
  await ctx.cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    await write(t);
    for (const id of new Set(ids)) views.push({ id, view: await rewriteRow(t, table, id, await t.get<CachedRow>(table, id)) });
  });
  notify(table, views);
}

/**
 * discardUnlessInflight 的写事务：在事务里重新读，还在、不是 inflight 才删，view 跟着回滚（K6-sugg4 ③：
 * 事务外查到的状态不算数，查完到删之间可能被 next() 取去发了）。返回删没删
 */
async function deleteUnlessInflight(ctx: Ctx, item: OutboxItem): Promise<boolean> {
  let done = false;
  await rewriteRecs(ctx, item.table, [item.id], async (t) => {
    const cur = await t.get<OutboxItem>(OUTBOX, item.op_id);
    if (!cur || cur.state === 'inflight') return;
    await t.delete(OUTBOX, item.op_id);
    done = true;
  });
  return done;
}

export function createOutbox(cache: Cache, opts: OutboxOptions = {}): Outbox {
  let status: OutboxStatus = { pending: 0, failed: 0, paused: null, remindRecs: EMPTY_SET };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(e: OutboxEvent) => void>();

  const refresh = async (): Promise<void> => {
    const items = await cache.tx([OUTBOX], 'readonly', (t) => t.getAll<OutboxItem>(OUTBOX));
    const paused = (await cache.getMeta('outbox_pause')) ?? null;
    const active = items.filter((i) => i.state !== 'failed');
    const remind = new Set(active.filter((i) => i.remind).map((i) => i.rec));
    const same =
      status.pending === active.length &&
      status.failed === items.length - active.length &&
      JSON.stringify(status.paused) === JSON.stringify(paused) &&
      status.remindRecs.size === remind.size &&
      [...remind].every((r) => status.remindRecs.has(r));
    if (same) return;
    status = { pending: active.length, failed: items.length - active.length, paused, remindRecs: remind.size ? remind : EMPTY_SET };
    for (const l of [...listeners]) l();
  };

  let suspended = false;
  const ctx: Ctx = {
    isSuspended: () => suspended,
    suspend: () => {
      suspended = true;
    },
    cache,
    opts,
    appVersion: opts.appVersion ?? buildInfo.version,
    now: opts.now ?? (() => Date.now()),
    newOpId: opts.newOpId ?? (() => crypto.randomUUID()),
    currentV: opts.currentV ?? OUTBOX_V,
    refresh,
    emit: (e) => {
      for (const l of [...eventListeners]) l(e);
    },
  };
  const list = (): Promise<OutboxItem[]> => cache.tx([OUTBOX], 'readonly', async (t) => (await t.getAll<OutboxItem>(OUTBOX)).sort(bySeq));
  const getItem = (opId: string): Promise<OutboxItem | undefined> => cache.tx([OUTBOX], 'readonly', (t) => t.get<OutboxItem>(OUTBOX, opId));

  return {
    boot: () => bootImpl(ctx),
    enqueue: (input) => enqueueImpl(ctx, input),
    async next() {
      if (suspended || status.paused || (await cache.getMeta('outbox_pause'))) return null;
      return cache.tx([OUTBOX], 'readwrite', async (t) => {
        const all = await t.getAll<OutboxItem>(OUTBOX);
        if (all.some((i) => i.state === 'inflight')) return null;
        const first = sendOrder(all, ctx.now(), ctx.currentV)[0];
        if (!first) return null;
        const item: OutboxItem = { ...first, state: 'inflight', sent: true };   // 发出去过：之后不再合并（K8 三审）
        await t.put(OUTBOX, item);
        return item;
      });
    },
    ack: (opId, ack) => ackImpl(ctx, opId, ack),
    fail: (opId, failure) => failImpl(ctx, opId, failure),
    async discard(opId) {
      if (suspended) return;
      const item = await getItem(opId);
      if (!item) return;
      await rewriteRecs(ctx, item.table, [item.id], (t) => t.delete(OUTBOX, opId));
      await refresh();
    },
    async discardUnlessInflight(opId) {
      if (suspended) return false;
      const item = await getItem(opId);
      const done = item && item.state !== 'inflight' ? await deleteUnlessInflight(ctx, item) : false;
      if (done) await refresh();
      return done;
    },
    async retryFailed(opIds) {
      if (suspended) return;
      const targets = (await list()).filter((i) => i.state === 'failed' && i.error !== 'gone' && (!opIds || opIds.includes(i.op_id)));   // gone 不给普通重试（K8 审查：要“恢复并保留我的修改”另发 patch）
      for (const table of new Set(targets.map((i) => i.table))) {
        const mine = targets.filter((i) => i.table === table);
        await rewriteRecs(ctx, table, mine.map((i) => i.id), async (t) => {
          // 在写事务里重新读，还是 failed 才改（N1：事务外读出来的对象不写回）
          for (const i of mine) {
            const cur = await t.get<OutboxItem>(OUTBOX, i.op_id);
            if (cur?.state === 'failed') await t.put(OUTBOX, { ...cur, state: 'pending', tries: 0, next_at: 0, error: null });
          }
        });
      }
      await refresh();
    },
    async resetInflight(opId) {
      if (suspended) return;
      await cache.tx([OUTBOX], 'readwrite', async (t) => {   // 事务里读、事务里写
        const items = opId === undefined ? await t.getAll<OutboxItem>(OUTBOX) : [await t.get<OutboxItem>(OUTBOX, opId)];
        for (const i of items) {
          if (i?.state === 'inflight') await t.put(OUTBOX, { ...i, state: 'pending', sent: true });
        }
      });
    },
    async clearBackoff() {
      if (suspended) return;
      await cache.tx([OUTBOX], 'readwrite', async (t) => {   // 事务里读、事务里写
        for (const i of await t.getAll<OutboxItem>(OUTBOX)) {
          if (i.state === 'pending' && i.next_at > 0) await t.put(OUTBOX, { ...i, next_at: 0 });
        }
      });
    },
    async resume() {
      if (suspended) return;
      await cache.deleteMeta('outbox_pause');
      await refresh();
    },
    applyServer: async (table, rows) => {
      if (suspended) return { skipped: [] };
      const report = await applyServerRows(cache, table, rows, { log: opts.log });
      // R-229 空壳会删掉这一行的队列项：重算状态
      if (rows.some((r) => r.shell === true)) await refresh();
      return report;
    },
    async dropServer(table, ids, expectRevs) {
      if (suspended) return;
      if (ids.length === 0) return;
      await rewriteRecs(ctx, table, ids, async (t) => {
        for (const id of ids) {
          const items = await t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', recKey(table, id));
          if (expectRevs) {
            // 整表重拉（K8）：写事务里复查，rev 变了（刚确认、刚拉到新的）或有 inflight 的项就不删
            const row = await t.get<CachedRow>(table, id);
            const rev = row?.server?.['rev'];
            if (!row?.server || (typeof rev === 'number' ? rev : -1) !== expectRevs.get(id) || items.some((i) => i.state === 'inflight')) continue;
          }
          await t.delete(table, id);
          for (const i of items) await t.delete(OUTBOX, i.op_id);
        }
      });
      await refresh();
    },
    list,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => {
        eventListeners.delete(fn);
      };
    },
    refresh,
    suspend: ctx.suspend,
    isSuspended: ctx.isSuspended,
  };
}
