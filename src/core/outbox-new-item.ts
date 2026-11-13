// 建一项新的 outbox 项（K8 方案复审一 R2 ①，docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3）
// 单独成文件、不进首屏：loadRowSchemas 每次入队前本来就要等的那个懒加载块里一起下载（rows.ts、manifest-source.ts 同批），
// enqueueImpl 用 rows.newItem 调它；K8 的 resolveGone 恢复项也用它，免得手写第二份走偏。
// 首屏只剩 0.3 KB 余量，直接放在 outbox.ts 里会让首屏多约 50 字节（gzip），所以放这里
import type { CachedRow } from './cache.ts';
import { recKey } from './outbox-logic.ts';
import type { Ctx } from './outbox-send.ts';
import type { EnqueueInput, OutboxItem, RecRef } from './outbox-types.ts';

/**
 * 子表 insert 没带 deps 时按父表外键自动补的依赖（R-350 评审第 3 条）：表 → [父表, 外键列]。
 * 子任务的 insert 必须排在主待办的 insert 后面发，否则服务器 todo_items_cap 报 not_found、这一项被丢掉；
 * 调用方哪里忘写 deps 也由这里兜住。调用方自己写了 deps 的照用，不再补
 */
const PARENT_OF: Readonly<Record<string, readonly [string, string]>> = { todo_items: ['todos', 'todo_id'] };

function depsOf(input: EnqueueInput): RecRef[] {
  if (input.deps?.length) return input.deps.map((d) => ({ table: d.table, id: d.id }));
  const parent = input.op === 'insert' && Object.hasOwn(PARENT_OF, input.table) ? PARENT_OF[input.table] : undefined;
  const pid = parent ? input.data[parent[1]] : undefined;
  return parent && typeof pid === 'string' ? [{ table: parent[0], id: pid }] : [];
}

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
    deps: depsOf(input),
    error: null,
  };
}

/** 一项 patch 换没换“哪一次提醒”：date、remind_days 改了，或者 time 在空和非空之间切换（日历编辑 patchOf 这时同一次写入里带 notified_for: null，
 *  和 reminders 的 remind-write.ts hasTimingChange 同一口径；全天 → 有时刻只看得出这一条） */
const timingChanged = (d: Readonly<Record<string, unknown>>): boolean =>
  'date' in d || 'remind_days' in d || ('time' in d && (d['time'] === null || d['notified_for'] === null));

/**
 * 两次还没发出的 patch 合并成一个（enqueueImpl 用 rows.mergePatch 调；放这里不进首屏）：后写的覆盖先写的。
 * 例外（接手清单 REMIND-offline-ack-merge 本机一半，四轮审查 R4-L1）：前一次换了“哪一次提醒”，后来的又写了“知道了”（notified_for 非空），
 * 那次“知道了”针对的是换之前的旧提醒，不并进去——合并后的 notified_for 保持前一次的值（patchOf 写的 null）；
 * 否则服务器触发器见补丁显式写了 notified_for 就照留，新日期那一次提醒会被当成“已提醒过”压住。
 * 先“知道了”后换提醒的顺序本来就对：后写的 notified_for: null 覆盖旧值
 * 已知取舍（K8 代码审查 S5，可接受）：只看 prev 换没换提醒。连续合并时 prev 一旦带了 date 等列，之后再按的“知道了”一律不并，
 * 哪怕按的是新那次提醒——结果是新提醒多推一次，比压住提醒好。待办改 due 不算“换一次提醒”：服务器按“同一天”判压住，挪截止日一般换了天，影响很小
 */
export function mergePatch(prev: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev, ...next };
  if (next['notified_for'] != null && timingChanged(prev)) {
    if ('notified_for' in prev) out['notified_for'] = prev['notified_for'];
    else delete out['notified_for'];
  }
  return out;
}
