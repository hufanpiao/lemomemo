// 发送循环（架构 4.2“发送”、4.4、0.27 第 1 点；outbox-types.ts 的 K8 约定）
// • 每发一项之前、每处理一个响应之前先看闸（boot.switching、outbox.isSuspended()、库已封存或已关）：设了就停，不发、不写回；
//   这时 outbox 的方法也可能抛 CacheClosedError，由 engine.ts 统一当作“停下”（不重试、不报错、不记日志）
// • insert：upsert(onConflict: id, ignoreDuplicates)；patch：apply_patch(p_table, p_id, p_patch, p_base_rev, p_op_id, p_own_revs)。
//   在途期间连续改同一字段：outbox 把还没发的 patch 合并、确认后推进 base_rev / own_revs（S1），这里原样把 base_rev、own_revs 带上去，
//   服务器跳过 fv[k] 在 own_revs 里的字段，所以不报冲突、不出冲突副本（TC-B1-24）
// • 每发一项之前看闸；outbox.next() 回来以后、发请求之前再看一次（next 期间可能设了闸，K8 审查必改 3）；
//   闸只是“放手”（drain、停下，没封存、没换账号）时：回包已经拿到就照常写回（ack、fail）再停；还没发或没拿到回包，
//   只把这一项改回 pending（带 sent，不再合并，K8 三审）再停，下一个主页接着发
// • 一批最多 20 项或 15 秒，到了返回 more，由引擎排到串行链尾接着发（免得长队列撑满 60 秒看门狗，K8 复审建议 1）
// • 结果：ok / conflict / forked → ack（conflict、forked 另发 conflict 事件并补拉这张表）；gone → 按永久失败进“发送失败”区、发 gone 事件并补拉这张表；
//   not_found（行没了或本人看不到：硬删、清理、移进隐私记、别人的行，4.4.1）→ 丢掉这一项（drop），行真被删了墓碑会删本机行；
//   patch_table_not_allowed、patch_bad_args 同样丢掉
// • 失败按 outbox.fail 的归类：auth → 刷新令牌再发（不计 tries，refreshFlow 按 TC-B1-88 ①～⑧）；刷新成功后马上又 401 → 不当被移除，
//   这一项按临时故障退避（tries + 1）、停发、记 auth_retry_401（K8 审查必改 4）；
//   transient（含 55P03 等不到行锁）→ 停下等退避；upgrade → 整个队列已暂停；removed → outbox 已设闸并发 removed 事件（main.tsx 接）；
//   disabled（account_disabled）→ outbox 已设闸、发 disabled 事件，这里停发；清库、回登录页由 sync-wiring 接事件做（架构 4.3）；
//   permanent、drop → 接着发下一项
// • 发每个请求（看令牌、发一项、刷新令牌）之前记下本机会话的 session_id（transport.sessionId()，接手清单 K6-sugg4 ①）：
//   被移除、停用时随 removed(code, sid) 或 outbox 事件（SendFailure.sid）带回，调用方只删这个会话——回包前别的标签页写进来的新会话不删
// 纯 TS：不准 import React 和任何功能（A1）
import type { Outbox, OutboxItem } from '../outbox-types.ts';
import type { NetResult, PatchResponse, SyncEvent, SyncLog, SyncTransport } from './types.ts';

export interface SendDeps {
  outbox: Outbox;
  transport: SyncTransport;
  /** 闸：换账号、被移除、库已封存或已关、同步已停 */
  gated(): boolean;
  /** 挡同步（低于最低版本、426）：不发 */
  blocked(): boolean;
  emit(e: SyncEvent): void;
  /** 刷新令牌发现被移除 / 连续 401：清本机、回登录页（main.tsx 和 outbox 的 removed 事件走同一个处理）；sid 见文件头 */
  removed(code: string, sid: string | null): void;
  /** conflict、forked、gone 之后补拉这张表（拿到别的设备改的值） */
  touched(table: string): void;
  /** 记日志（act + coll / code，不记内容和服务器原文） */
  log?: SyncLog;
  /**
   * 闸设上了，但只是放手（drain、停下），库没封存、没换账号：在途的这一项改回 pending 再返回（K8 复审必改）。
   * 封存、换账号时照旧不写库（页面马上重新载入，下次启动 outbox.boot 复位）
   */
  released?(): boolean;
  /** 一批最多发多少项、多久（毫秒）；默认 SEND_BATCH */
  batch?: { items: number; ms: number };
  /** 量批次时长用；默认 Date.now */
  now?(): number;
}

/** 一批最多 20 项或 15 秒（K8 复审建议 1） */
export const SEND_BATCH = { items: 20, ms: 15_000 };

/**
 * 刷新令牌的结果：ok 再发；network 临时故障（留在 pending、不计 tries，稍后再试）；
 * removed 被移除（code、sid 交给 removed；sid = 被拒的那次刷新发出前本机会话的 session_id）
 */
export type RefreshOutcome = { kind: 'ok' } | { kind: 'network' } | { kind: 'removed'; code: string; sid: string | null };

/** 本机会话现在的 session_id；实现抛错时按读不出（null） */
export function sessionIdNow(t: Pick<SyncTransport, 'sessionId'>): string | null {
  try {
    return t.sessionId();
  } catch {
    return null;
  }
}

/**
 * 刷新令牌（TC-B1-88）：① 断网 ② 503 ③ 429 → network；④⑤⑥ → removed；
 * ⑦ 别的 4xx 记一条日志再试一次，成功就 ok；⑧ 两次都是别的 4xx → removed（auth_refresh_failed）。
 * 每次刷新前记下本机会话的 session_id（K6-sugg4 ①），被移除时带回最后一次的
 */
export async function refreshFlow(t: Pick<SyncTransport, 'refreshSession' | 'sessionId'>, log?: (code: string) => void): Promise<RefreshOutcome> {
  let sid: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    sid = sessionIdNow(t);
    const r = await t.refreshSession();
    if (r === 'ok') return { kind: 'ok' };
    if (r === 'network') return { kind: 'network' };
    if (r === 'removed') return { kind: 'removed', code: 'session_not_found', sid };
    log?.('auth_refresh_4xx');
  }
  return { kind: 'removed', code: 'auth_refresh_failed', sid };
}

/**
 * done：队列里没有能发的了；more：这一批发满了，还有，重新排队接着发；retry：断网或服务器暂时出错，等退避或下一个时机；
 * paused：挡同步或 426 暂停；stopped：闸设上了；removed：被移除（已交给 removed 处理）
 */
export type SendOutcome = 'done' | 'more' | 'retry' | 'paused' | 'stopped' | 'removed';

/** 拿到一项、还没拿到回包时遇到闸：只是放手就把这一项改回 pending（见 SendDeps.released），封存时不写库 */
async function stopWith(d: SendDeps, opId: string): Promise<'stopped'> {
  if (d.released?.()) await d.outbox.resetInflight(opId);
  return 'stopped';
}

async function sendItem(t: SyncTransport, item: OutboxItem): Promise<NetResult<PatchResponse>> {
  try {
    if (item.op === 'insert') {
      const r = await t.insertRow(item.table, item.data);
      return r.ok ? { ok: true, value: { status: 'ok', rev: r.value.rev, prev_rev: null } } : r;
    }
    return await t.applyPatch({
      p_table: item.table,
      p_id: item.id,
      p_patch: item.data,
      p_base_rev: item.base_rev,
      p_op_id: item.op_id,
      p_own_revs: item.own_revs,
    });
  } catch {
    return { ok: false, error: { network: true } };   // 实现不该抛；万一抛了按断网处理，这一项不会卡在 inflight
  }
}

export async function sendAll(d: SendDeps): Promise<SendOutcome> {
  if (d.gated()) return 'stopped';
  if (d.blocked()) return 'paused';
  const sid0 = sessionIdNow(d.transport);
  const s = await d.transport.ensureSession();
  if (d.gated()) return 'stopped';
  if (s === 'removed') {
    d.removed('session_not_found', sid0);
    return 'removed';
  }
  if (s === 'network') return 'retry';
  let authRetried = false;
  const now = d.now ?? (() => Date.now());
  const batch = d.batch ?? SEND_BATCH;
  const t0 = now();
  for (let n = 0; ; n++) {
    if (d.gated()) return 'stopped';
    if (n >= batch.items || now() - t0 >= batch.ms) return 'more';
    const item = await d.outbox.next();
    if (!item) return 'done';
    if (d.gated()) return stopWith(d, item.op_id);   // next 期间设了闸：不发
    const sid = sessionIdNow(d.transport);   // 这一项带着哪个会话发出去（K6-sugg4 ①）
    const res = await sendItem(d.transport, item);
    // 封存、换账号：不写回结果（下次启动 boot 复位）；只是放手：回包已拿到，照常写回，循环开头再停
    if (d.gated() && !d.released?.()) return 'stopped';
    if (res.ok) {
      authRetried = false;
      const r = res.value;
      if (r.status === 'gone') {
        await d.outbox.fail(item.op_id, { status: 409, code: 'gone' });
        d.emit({ type: 'gone', table: item.table, id: item.id, opId: item.op_id, data: item.data });
        d.log?.('sync_gone', { coll: item.table, code: 'gone' });   // 0.38 第 67 条：不记 data、opId、记录 id
        d.touched(item.table);   // 拿到服务器上已软删的那一行，界面据此显示“已被删除”
        continue;
      }
      if (r.status === 'not_found') {
        await d.outbox.fail(item.op_id, { status: 404, code: 'not_found' });
        continue;
      }
      await d.outbox.ack(item.op_id, { status: r.status, rev: r.rev, prev_rev: r.prev_rev });
      if (r.status !== 'ok') {
        d.emit({
          type: 'conflict', status: r.status, table: item.table, id: item.id,
          conflicts: r.conflicts ?? [], old: r.old ?? null, forkId: r.fork_id ?? null,
        });
        d.log?.('sync_conflict', { coll: item.table, code: r.status });   // 0.38 第 67 条：code 是 conflict / forked；不记 old、conflicts、forkId、记录 id
        d.touched(item.table);
      }
      continue;
    }
    const kind = await d.outbox.fail(item.op_id, { ...res.error, sid });
    if (kind === 'drop' && res.error.code === 'patch_bad_args') {
      // 服务器把 22xxx、23514、23502 也转成 patch_bad_args：丢掉这一项，但记下表名和 sqlstate，免得掩盖服务器触发器的 bug
      // （不记 sqlerrm：可能带用户填的值，0.38 第 62 条）
      d.log?.('sync_patch_bad_args', { coll: item.table, ...(res.error.detail ? { code: res.error.detail } : {}) });
    }
    if (kind === 'permanent' || kind === 'drop') continue;
    if (kind === 'upgrade') return 'paused';
    if (kind === 'removed') return 'removed';   // outbox 已设闸、发了 removed 事件
    if (kind === 'disabled') return 'stopped';   // outbox 已设闸、发了 disabled 事件；清库、回登录页由 sync-wiring 接事件做（架构 4.3）
    if (kind === 'transient') return 'retry';
    // auth：刷新以后马上又 401：不无限重发，也不当被移除；这一项按临时故障退避，停发，记日志
    if (authRetried) {
      d.log?.('auth_retry_401');
      await d.outbox.fail(item.op_id, { network: true, code: 'auth_retry_401' });
      return 'retry';
    }
    authRetried = true;
    if (d.gated()) return stopWith(d, item.op_id);
    const r = await refreshFlow(d.transport, d.log);
    if (d.gated()) return stopWith(d, item.op_id);
    if (r.kind === 'ok') continue;
    if (r.kind === 'removed') {
      d.removed(r.code, r.sid);
      return 'removed';
    }
    return 'retry';   // 断网、5xx、429 等刷新失败：留在 pending、不计 tries，稍后再刷新再发（TC-B1-82 ④、TC-B1-88 ①②③）
  }
}
