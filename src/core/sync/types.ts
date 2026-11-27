// 同步的类型：网络一侧的接口 SyncTransport（实现在 platform/supabase/sync-transport.ts，由 app 层注入；测试用假的）、
// 宽容读取的接口 ParseServerRows、同步层对外的事件和状态
// 纯 TS：不准 import React 和任何功能；不准直接联网（网络全在 platform）
import type { ConfigRows, NetResult, PatchArgs, PatchResponse, PullQuery, RealtimeHandlers, RealtimeStatus, SessionCheck, TombstoneQuery, TzReportResult } from '../../../shared/schema/sync.ts';
import type { ServerRowInput } from '../outbox-types.ts';

// 线上形状在 shared/schema/sync.ts；这里转出，core 里的引用不变
export type {
  ConfigRows,
  NetResult,
  PatchArgs,
  PatchResponse,
  PullQuery,
  RealtimeHandlers,
  RealtimeStatus,
  SessionCheck,
  TombstoneQuery,
  TombstoneRow,
  TzReportResult,
} from '../../../shared/schema/sync.ts';

/**
 * 记一条日志（logs 表）：act 是登记过的动作名（≤ 32 字），coll 表名、code 错误码或 sqlstate。
 * 不记内容，也不记服务器返回的原始错误文本。
 * itemId（logs.item_id）只给数据字典写明要记录 id 的 act 用（现在只有 outbox_vault_shell_drop）；
 * 同步层的 act 一律不填；宽容读取丢行（row_unknown）带记录 id。
 * fields：出问题的列名（logs.fields；只有列名，不含内容），现在只有 row_unknown 用
 */
export type SyncLog = (act: string, f?: { coll?: string; code?: string; itemId?: string; fields?: readonly string[] }) => void;

/**
 * 同步用到的全部网络调用。实现只做“请求 → 结果”，不碰本机库；所有方法不抛（网络错一律变成 { ok: false, error: { network: true } }）
 */
export interface SyncTransport {
  /** 发送前看令牌：快到期（≤ 60 秒）先刷新 */
  ensureSession(): Promise<SessionCheck>;
  /** 收到 401 后刷新一次 */
  refreshSession(): Promise<SessionCheck>;
  /**
   * 本机会话现在的 session_id（同步读，没有会话、读不出为 null；不发请求）。send.ts、refreshFlow 在发请求前记下它，
   * 被移除、停用时随事件带回，离开本机时只删这个会话
   */
  sessionId(): string | null;
  /** insert：upsert(onConflict: id, ignoreDuplicates)（幂等）；返回服务器上这一行的 rev */
  insertRow(table: string, data: Readonly<Record<string, unknown>>): Promise<NetResult<{ rev: number }>>;
  applyPatch(args: PatchArgs): Promise<NetResult<PatchResponse>>;
  pullRows(table: string, q: PullQuery): Promise<NetResult<unknown[]>>;
  /** 按 id 单独补拉（宽容读取记下的“待补拉”） */
  fetchByIds(table: string, ids: readonly string[]): Promise<NetResult<unknown[]>>;
  pullTombstones(q: TombstoneQuery): Promise<NetResult<unknown[]>>;
  /** 订阅 Realtime：同步表只订阅 INSERT、UPDATE，tombstones 只订阅 INSERT。返回取消函数 */
  subscribe(tables: readonly string[], h: RealtimeHandlers): () => void;
  /** 启动、切到前台时整行刷新 app_config、profiles 本人那一行 */
  fetchConfig(): Promise<NetResult<ConfigRows>>;
  reportTz(tz: string, deviceId: string, platform: string): Promise<NetResult<TzReportResult>>;
}

/**
 * 宽容读取：把服务器来的原始行变成能进本机库的行。
 * - rows：能用的行（带不认识的值的标 ro；隐私记行只留 cipherCols 和 neutralCols）；
 * - bad：整行解析不了的 id（同步层记进 meta 的 refetch:<表>，下次启动单独补拉）。
 * 纯函数：不碰本机库、不联网；日志（row_unknown，不记内容）由它自己在函数里交给日志层
 */
export interface ParsedRows {
  rows: ServerRowInput[];
  bad: string[];
}
export type ParseServerRows = (table: string, raw: readonly unknown[]) => ParsedRows;

export type SyncEvent =
  /** apply_patch 回 conflict / forked：界面提示“已在另一台设备上改过”，提供“看对方的版本” */
  | {
      type: 'conflict';
      status: 'conflict' | 'forked';
      table: string;
      id: string;
      conflicts: readonly string[];
      old: Readonly<Record<string, unknown>> | null;
      /** forked 时冲突副本的 id（界面可跳过去看）；conflict 为 null */
      forkId: string | null;
      /** 回这个结果的那一项的 op_id（冲突提示按它认“刚恢复”的那一项） */
      opId: string;
    }
  /**
   * apply_patch 回 gone（一边删一边改）：这一项已按永久失败进“发送失败”区（outbox 同时发 error 事件，code = gone）。
   * 界面提示“这条已在另一台设备上删除”：“恢复并保留我的修改”= core/write-gone.ts 的 resolveGone(table, id, 'restore')
   * （同一事务里合并成一项带 deleted_at: null 的 patch、删掉 gone 项）；“不用了”= resolveGone(table, id, 'drop')
   */
  | { type: 'gone'; table: string; id: string; opId: string; data: Readonly<Record<string, unknown>> };

export interface SyncState {
  /** 正在拉取或发送（顶部“正在同步…”） */
  syncing: boolean;
  realtime: RealtimeStatus;
  /** 最近一次拉取成功的时间（epoch ms） */
  lastPullAt: number | null;
  /** 同步已停（换账号、被移除、库已封存或关闭、cache === null） */
  stopped: boolean;
}
