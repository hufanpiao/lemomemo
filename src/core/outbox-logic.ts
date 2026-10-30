// 离线写入队列的纯函数（架构 4.2、0.27 第 1 点、第七轮 S1）：失败归类、退避、rebase、发送顺序、确认后推进、入队校验
// 不碰 IndexedDB，单独测（__tests__/outbox-logic.test.ts）
// 纯 TS：不准 import React 和任何功能（A1）
import { insertSchema, patchSchema, rowsWrite, type WritableTable } from '../../shared/schema/rows.ts';
import type { ServerRow } from './cache.ts';
import { allTables, type Manifest } from './manifest.ts';
import { OUTBOX_V } from './outbox-migrations.ts';
import type { AckResult, EnqueueInput, FailureKind, OutboxItem, SendFailure } from './outbox-types.ts';

/**
 * 丢掉这一项、不重试的错误码（4.2 幂等：vault_required、settings_key_immutable；apply_patch 的 not_found，K6 审查 L2；
 * apply_patch 的参数检查 patch_table_not_allowed、patch_bad_args，架构 4.4.1、0.38 第 57 条）
 */
export const DROP_CODES: readonly string[] = ['vault_required', 'settings_key_immutable', 'not_found', 'patch_table_not_allowed', 'patch_bad_args'];
/** 被移除、被停用：走“被移除”流程（TC-B1-77 ⑤），不当成令牌过期去刷新重发（K6 审查 L2） */
export const REMOVED_CODES: readonly string[] = ['session_revoked'];
/**
 * 账号被停用（管理员停用 account_disabled；注销冷静期 account_pending_deletion，0.29 续第 131、134 条）：
 * 和被移除一样清本机库、草稿和队列，回登录页（架构 4.3“注销”、4.3b、0.29 续第 131 条②）；登录页按错误码提示“已停用”或冷静期的恢复入口。
 * 4.4.1 的“不丢队列”指 apply_patch 必须先查 account_disabled、不能把停用误判成 not_found 丢项，不是保留本机
 */
export const DISABLED_CODES: readonly string[] = ['account_disabled', 'account_pending_deletion'];
/** 本机就能判定的永久错误（没有 HTTP 状态时） */
const LOCAL_PERMANENT_CODES: readonly string[] = ['validation', 'invalid_row'];
/** 令牌过期一类：刷新令牌后重发，不计 tries（TC-B1-82 ②） */
const AUTH_CODES: readonly string[] = ['jwt_expired', 'PGRST301', 'PGRST303'];
/** 不看 HTTP 状态、一律退避重试的码：55P03 = apply_patch 等不到行锁（lock_timeout 3 秒，整个调用已回滚，架构 4.4.1） */
const TRANSIENT_CODES: readonly string[] = ['55P03'];

/** 退避上限 5 分钟 */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** own_revs 最多 20 个 */
export const MAX_OWN_REVS = 20;

/**
 * 服务器忙（TC-B1-90；架构 0.29 续第 110 条①、续第 119 条②）：Edge Function 回 503 {error: 'try_later'}；
 * 走 PostgREST 时 raise exception 'try_later' 是 400、code 由传输层从 message 取出。只看 code，不看状态码。
 * 注意：现在 try_later 实际到不了队列——队列只经 PostgREST 调 apply_patch，apply_patch 不调 session_alive，
 * 数据库里也没有抛 try_later 的地方；这一支是按架构续第 119 条②预先守住的（R-272）。退避和计数见 outbox-send.ts
 */
export const TRY_LATER = 'try_later';
export const isTryLater = (f: SendFailure): boolean => f.code === TRY_LATER;

/** 连续第 n 次收到 try_later 以后等多久：5 秒、30 秒、2 分钟，之后每 5 分钟（续第 119 条②）；n ≤ 0 按第一次算 */
const TRY_LATER_STEPS_MS: readonly number[] = [5_000, 30_000, 120_000, MAX_BACKOFF_MS];
export function tryLaterBackoffMs(n: number): number {
  const i = Math.min(Math.max(n, 1), TRY_LATER_STEPS_MS.length) - 1;
  return TRY_LATER_STEPS_MS[i] ?? MAX_BACKOFF_MS;
}

/** 失败归类（426 不算永久失败，0.27 第 1 点）；各类的处理见 outbox-types.ts 的 FailureKind。401 的重发次数由 K8 管 */
export function classifyFailure(f: SendFailure): FailureKind {
  if (f.status === 426 || f.code === 'upgrade_required') return 'upgrade';
  // try_later 是临时故障，排在 4xx 判断之前：经 PostgREST 来的是 400，不能落进“其他 4xx 永久失败”（续第 119 条②）
  if (isTryLater(f)) return 'transient';
  if (f.code !== undefined && DISABLED_CODES.includes(f.code)) return 'disabled';
  if (f.code !== undefined && REMOVED_CODES.includes(f.code)) return 'removed';
  if (f.code !== undefined && DROP_CODES.includes(f.code)) return 'drop';
  if (f.status === 401 || (f.code !== undefined && AUTH_CODES.includes(f.code))) return 'auth';
  if (f.code !== undefined && TRANSIENT_CODES.includes(f.code)) return 'transient';
  if (f.network || f.status === undefined || f.status === 0) {
    return f.code !== undefined && LOCAL_PERMANENT_CODES.includes(f.code) ? 'permanent' : 'transient';
  }
  if (f.status === 408 || f.status === 429 || f.status >= 500) return 'transient';
  return 'permanent';
}

/** 第 tries 次失败以后等多久：2、4、8 秒……最长 5 分钟 */
export function backoffMs(tries: number): number {
  return Math.min(2 ** Math.max(1, tries) * 1000, MAX_BACKOFF_MS);
}

export function recKey(table: string, id: string): string {
  return `${table}:${id}`;
}

/** 按 seq 排序 */
export const bySeq = (a: OutboxItem, b: OutboxItem): number => a.seq - b.seq;

/** server 上叠加这条记录还没确认的项（pending、inflight，不含 failed），得到 view（4.3 的 rebase） */
export function rebaseView(server: ServerRow | null, items: readonly OutboxItem[]): ServerRow | null {
  let v: Record<string, unknown> | null = server ? { ...server } : null;
  for (const i of [...items].sort(bySeq)) {
    if (i.state === 'failed') continue;
    if (i.op === 'insert') v = { ...(v ?? {}), ...i.data, id: i.id };
    else if (v) v = { ...v, ...i.data };
  }
  return v as ServerRow | null;
}

/**
 * 可以发的项按发送顺序排好（next() 取第一项）：
 * - 只看 pending、格式版本等于当前的（比自己高的、迁移失败的留着不发）；
 * - 一条记录最早的那项还在退避中，整条记录都等着（同一条的项不颠倒）；
 * - 带提醒的记录整条提前（连同它依赖的记录）；其余按 seq；
 * - 依赖的记录还有没发的项时，先发依赖；依赖在退避中，本条也等着
 */
export function sendOrder(items: readonly OutboxItem[], now: number, currentV: number = OUTBOX_V): OutboxItem[] {
  const groups = new Map<string, OutboxItem[]>();
  for (const i of [...items].sort(bySeq)) {
    if (i.state === 'failed') continue;
    const g = groups.get(i.rec);
    if (g) g.push(i);
    else groups.set(i.rec, [i]);
  }
  const blocked = new Set<string>();
  for (const [rec, g] of groups) {
    const first = g[0];
    if (!first || first.state !== 'pending' || first.v !== currentV || first.next_at > now) blocked.add(rec);
  }
  const depsOf = (rec: string): string[] => {
    const out = new Set<string>();
    for (const i of groups.get(rec) ?? []) for (const d of i.deps) out.add(recKey(d.table, d.id));
    out.delete(rec);
    return [...out];
  };
  // 依赖被挡住的，自己也挡住（反复传递到不再变化）
  let changed = true;
  while (changed) {
    changed = false;
    for (const rec of groups.keys()) {
      if (blocked.has(rec)) continue;
      if (depsOf(rec).some((d) => blocked.has(d))) {
        blocked.add(rec);
        changed = true;
      }
    }
  }
  const order: OutboxItem[] = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const emit = (rec: string): void => {
    if (emitted.has(rec) || visiting.has(rec) || blocked.has(rec) || !groups.has(rec)) return;
    visiting.add(rec);
    for (const d of depsOf(rec)) emit(d);
    visiting.delete(rec);
    emitted.add(rec);
    for (const i of groups.get(rec) ?? []) {
      if (i.state !== 'pending' || i.v !== currentV || i.next_at > now) break;   // 同一条记录：前一项发不了，后面的都等着
      order.push(i);
    }
  };
  const recs = [...groups.keys()];   // 已按每条记录最早的 seq 排好（Map 保留插入顺序）
  for (const rec of recs) if ((groups.get(rec) ?? []).some((i) => i.remind)) emit(rec);
  for (const rec of recs) emit(rec);
  return order;
}

/**
 * 收到确认后推进同一条记录排在后面的 patch（S1）：
 * - insert 确认：后面 base_rev 还是 null 的 patch 改成 rev；
 * - prev_rev == 这次发出的 base_rev（中间没有别的设备写过）：base_rev 改成 rev，own_revs 清空；
 * - 否则：base_rev 不动，rev 加进 own_revs；超过 20 个清空（当作中间有人写过，按冲突处理）。
 * 返回改过的项（新对象）
 */
export function advanceAfterAck(later: readonly OutboxItem[], sent: OutboxItem, ack: AckResult): OutboxItem[] {
  const out: OutboxItem[] = [];
  for (const i of later) {
    if (i.rec !== sent.rec || i.seq <= sent.seq || i.op !== 'patch') continue;
    if (sent.op === 'insert') {
      if (i.base_rev === null) out.push({ ...i, base_rev: ack.rev, own_revs: [] });
    } else if (ack.prev_rev !== null && ack.prev_rev === sent.base_rev) {
      out.push({ ...i, base_rev: ack.rev, own_revs: [] });
    } else {
      const own = [...i.own_revs, ack.rev];
      out.push({ ...i, own_revs: own.length > MAX_OWN_REVS ? [] : own });
    }
  }
  return out;
}

/** 入队被拒（调用方提示，不进队列） */
export class OutboxRejectError extends Error {
  override name = 'OutboxRejectError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** 按 rows.ts 的严格版（有的表）或清单的可写列校验；返回错误码或 null */
export function validateWrite(input: EnqueueInput, list?: readonly Manifest[]): string | null {
  const t = allTables(list).find((x) => x.schema === 'public' && x.name === input.table);
  if (!t || t.sync !== true) return 'table_not_synced';
  if (input.op === 'insert' && input.data['id'] !== input.id) return 'id_mismatch';
  if (Object.hasOwn(rowsWrite, input.table)) {
    const table = input.table as WritableTable;
    try {
      const schema = input.op === 'insert' ? insertSchema(table) : patchSchema(table);
      return schema.safeParse(input.data).success ? null : 'invalid_row';
    } catch {
      return 'insert_not_allowed';
    }
  }
  const drop = input.op === 'insert' ? t.updateOnly : t.insertOnly;
  for (const k of Object.keys(input.data)) {
    if (!t.clientWritable.includes(k) || drop.includes(k)) return `column_not_writable:${k}`;
  }
  return null;
}
