// 建一项新的 outbox 项（K8 方案复审一 R2 ①，docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3）
// 单独成文件、不进首屏：loadRowSchemas 每次入队前本来就要等的那个懒加载块里一起下载（rows.ts、manifest-source.ts 同批），
// enqueueImpl 用 rows.newItem 调它；K8 的 resolveGone 恢复项也用它，免得手写第二份走偏。
// 首屏只剩 0.3 KB 余量，直接放在 outbox.ts 里会让首屏多约 50 字节（gzip），所以放这里
import type { CachedRow } from './cache.ts';
import { recKey } from './outbox-logic.ts';
import type { Ctx } from './outbox-send.ts';
import type { EnqueueInput, OutboxItem } from './outbox-types.ts';

/**
 * 建一项新的 outbox 项（不合并到已有项时用）。op_id、base_rev、own_revs、client_ts、v、app、seq、remind、deps 的规则只写在这里：
 * • 这条记录前面有 insert（afterInsert）：base_rev 为 null、own_revs 为空（服务器上还没有这一行，没有可比的版本）；
 * • 否则 patch 的 base_rev 取本机 server.rev，own_revs 拷 row.own_revs；insert 两者都不带；
 * • seq 取全队列（all）最大值加 1；ts 由调用方在事务外取一次（ctx.now()），这里不再取时间。
 * row 是事务里读到的那一行，mine 是这条记录现有的项（按 seq 排好），all 是整个队列
 */
export function newItem(
  ctx: Ctx,
  input: EnqueueInput,
  row: CachedRow | undefined,
  mine: readonly OutboxItem[],
  all: readonly OutboxItem[],
  ts: number,
): OutboxItem {
  const { table, id, op } = input;
  const serverRev = row?.server?.['rev'];
  const afterInsert = mine.some((i) => i.op === 'insert');
  return {
    op_id: ctx.newOpId(),
    table,
    id,
    rec: recKey(table, id),
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
