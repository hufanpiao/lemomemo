// 离线写入队列的“发送结果”两步：ack（确认后推进、更新本机的 server 副本）和 fail（五类失败 + 被移除）。outbox.ts 用
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache, CachedRow, ServerRow } from './cache.ts';
import { OUTBOX } from './cache-schema.ts';
import { advanceAfterAck, backoffMs, classifyFailure, MAX_OWN_REVS } from './outbox-logic.ts';
import { notify, rewriteRow } from './outbox-rows.ts';
import type { AckResult, FailureKind, OutboxEvent, OutboxItem, OutboxOptions, SendFailure } from './outbox-types.ts';

/** createOutbox 里各步共用的东西 */
export interface Ctx {
  cache: Cache;
  opts: OutboxOptions;
  appVersion: string;
  now: () => number;
  newOpId: () => string;
  currentV: number;
  refresh: () => Promise<void>;
  emit: (e: OutboxEvent) => void;
  /** 闸（换账号、被移除）：设上以后 outbox 一律拒绝 */
  isSuspended: () => boolean;
  suspend: () => void;
}

/** forked：title、body 另存成了冲突副本，服务器这一行没改这两列；其余列照常改了 */
const FORK_COLUMNS: readonly string[] = ['title', 'body'];

function appliedColumns(sent: OutboxItem, ack: AckResult): Record<string, unknown> {
  if (ack.status !== 'forked') return sent.data;
  return Object.fromEntries(Object.entries(sent.data).filter(([k]) => !FORK_COLUMNS.includes(k)));
}

export async function ackImpl(ctx: Ctx, opId: string, ack: AckResult): Promise<void> {
  if (ctx.isSuspended()) return;
  const found = await ctx.cache.tx([OUTBOX], 'readonly', (t) => t.get<OutboxItem>(OUTBOX, opId));
  if (!found || ctx.isSuspended()) return;
  const { table, id } = found;
  let view: ServerRow | null = null;
  await ctx.cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    const sent = await t.get<OutboxItem>(OUTBOX, opId);
    if (!sent) return;
    await t.delete(OUTBOX, opId);
    for (const i of advanceAfterAck(await t.getAllByIndex<OutboxItem>(OUTBOX, 'rec', sent.rec), sent, ack)) await t.put(OUTBOX, i);

    // 本机的 server 副本：中间没有别的设备写过时，直接认为服务器已是“server + 这次的修改”，rev 推进
    const row = await t.get<CachedRow>(table, id);
    const server = row?.server ?? null;
    let nextServer: ServerRow | null = server;
    let own = row?.own_revs ?? [];
    if (sent.op === 'insert') {
      nextServer = { ...(server ?? {}), ...sent.data, id, rev: ack.rev } as ServerRow;
      own = [];
    } else if (server && ack.prev_rev !== null && ack.prev_rev === sent.base_rev) {
      nextServer = { ...server, ...appliedColumns(sent, ack), rev: ack.rev } as ServerRow;
      own = [];
    } else {
      // 中间夹了别的设备的写入（K6 审查 M6）：服务器上已经是“别人的修改 + 这次的修改”，本机还不知道别人改了什么。
      // 先把这次确认的修改叠进 server（rev 保持旧值，等 K8 拉到新行再整行替换），界面不回滚；rev 记进 own_revs
      if (server) nextServer = { ...server, ...appliedColumns(sent, ack) } as ServerRow;
      own = [...own, ack.rev];
      if (own.length > MAX_OWN_REVS) own = [];
    }
    const base: CachedRow = { id, server: nextServer, view: row?.view ?? null };
    if (row?.ro) base.ro = true;
    if (own.length) base.own_revs = own;
    view = await rewriteRow(t, table, id, base);
  });
  notify(table, [{ id, view }]);
  await ctx.refresh();
}

export async function failImpl(ctx: Ctx, opId: string, failure: SendFailure): Promise<FailureKind> {
  const kind = classifyFailure(failure);
  if (ctx.isSuspended()) return kind;
  if (kind === 'removed') {
    // 被移除（session_revoked、account_disabled）：设闸、不回滚、不重试；调用方清空本机、回登录页（TC-B1-77 ⑤），队列随库一起丢
    ctx.suspend();
    ctx.emit({ type: 'removed', code: failure.code ?? 'removed' });
    return kind;
  }
  // 先读出这一项在哪张表（写事务的范围要用）；写的时候在写事务里重新读，没有了就不写（K6 复审 N1：
  // 两次之间可能已经换账号清了库，事务外读出来的对象不能写回去，否则上一个账号的项会落进新账号的库）
  const found = await ctx.cache.tx([OUTBOX], 'readonly', (t) => t.get<OutboxItem>(OUTBOX, opId));
  if (!found) return kind;
  const { table, id } = found;
  if (kind === 'upgrade' || kind === 'auth' || kind === 'transient') {
    if (ctx.isSuspended()) return kind;
    const wrote = await ctx.cache.tx([OUTBOX], 'readwrite', async (t) => {
      const cur = await t.get<OutboxItem>(OUTBOX, opId);
      if (!cur) return false;
      const tries = kind === 'transient' ? cur.tries + 1 : cur.tries;
      const next_at = kind === 'transient' ? ctx.now() + backoffMs(tries) : cur.next_at;
      await t.put(OUTBOX, { ...cur, state: 'pending', tries, next_at });
      return true;
    });
    if (!wrote) return kind;
    if (kind === 'upgrade') {
      if (ctx.isSuspended()) return kind;
      const min = failure.min ?? null;
      await ctx.cache.setMeta('outbox_pause', { reason: 'upgrade', min, app: ctx.appVersion, at: ctx.now() });
      await ctx.refresh();
      ctx.emit({ type: 'upgrade_required', min });
      return kind;
    }
    await ctx.refresh();
    return kind;
  }
  const code = failure.code ?? (failure.status !== undefined ? `http_${failure.status}` : 'error');
  if (ctx.isSuspended()) return kind;
  let view: ServerRow | null = null;
  let before: OutboxItem | null = null;
  let failed: OutboxItem | null = null;
  await ctx.cache.tx([table, OUTBOX], 'readwrite', async (t) => {
    const cur = await t.get<OutboxItem>(OUTBOX, opId);
    if (!cur) return;
    before = cur;
    if (kind === 'drop') await t.delete(OUTBOX, opId);
    else {
      failed = { ...cur, state: 'failed', error: code };
      await t.put(OUTBOX, failed);
    }
    view = await rewriteRow(t, table, id, await t.get<CachedRow>(table, id));
  });
  const item: OutboxItem | null = before;
  if (!item) return kind;
  notify(table, [{ id, view }]);
  await ctx.refresh();
  ctx.emit(kind === 'drop' || !failed ? { type: 'rejected', item, code } : { type: 'error', item: failed, code });
  return kind;
}

