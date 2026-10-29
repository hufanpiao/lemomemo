// 同步（K8）的类型：网络一侧的接口 SyncTransport（实现在 platform/supabase/sync-transport.ts，由 app 层注入；测试用假的）、
// 宽容读取（K7）的接口 ParseServerRows、同步层对外的事件和状态
// 依据：架构 4.2（发送）、4.3（Realtime、轮询、增量拉取退 10 分钟、25 天整表重拉）、4.4（apply_patch）、0.29 续第 121 条（墓碑）
// 纯 TS：不准 import React 和任何功能（A1）；不准直接联网（A12：网络全在 platform）
import type { ConfigRows, NetResult, PatchArgs, PatchResponse, PullQuery, RealtimeHandlers, RealtimeStatus, SessionCheck, TombstoneQuery, TzReportResult } from '../../../shared/schema/sync.ts';
import type { ServerRowInput } from '../outbox-types.ts';

// 线上形状在 shared/schema/sync.ts（架构 4.3b、0.38 第 58 条）；这里转出，core 里的引用不变
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
 * 记一条日志（logs 表，数据字典 4.6）：act 是登记过的动作名（≤ 32 字），coll 表名、code 错误码或 sqlstate。
 * 不记内容，也不记服务器返回的原始错误文本（0.38 第 62 条）。
 * itemId（logs.item_id）只给数据字典 4.6 写明要记录 id 的 act 用（现在只有 outbox_vault_shell_drop，接手清单 K6-log）；
 * 同步层的 act（0.38 第 67 条）一律不填
 */
export type SyncLog = (act: string, f?: { coll?: string; code?: string; itemId?: string }) => void;

/**
 * 同步用到的全部网络调用。实现只做“请求 → 结果”，不碰本机库；所有方法不抛（网络错一律变成 { ok: false, error: { network: true } }）
 */
export interface SyncTransport {
  /** 发送前看令牌：快到期（≤ 60 秒）先刷新（TC-B1-82 ①） */
  ensureSession(): Promise<SessionCheck>;
  /** 收到 401 后刷新一次（TC-B1-82 ②～④） */
  refreshSession(): Promise<SessionCheck>;
  /**
   * 本机会话现在的 session_id（同步读，没有会话、读不出为 null；不发请求）。send.ts、refreshFlow 在发请求前记下它，
   * 被移除、停用时随事件带回，离开本机时只删这个会话（接手清单 K6-sugg4 ①）
   */
  sessionId(): string | null;
  /** insert：upsert(onConflict: id, ignoreDuplicates)（4.2 幂等）；返回服务器上这一行的 rev */
  insertRow(table: string, data: Readonly<Record<string, unknown>>): Promise<NetResult<{ rev: number }>>;
  applyPatch(args: PatchArgs): Promise<NetResult<PatchResponse>>;
  pullRows(table: string, q: PullQuery): Promise<NetResult<unknown[]>>;
  /** 按 id 单独补拉（K7 记下的“待补拉”） */
  fetchByIds(table: string, ids: readonly string[]): Promise<NetResult<unknown[]>>;
  pullTombstones(q: TombstoneQuery): Promise<NetResult<unknown[]>>;
  /** 订阅 Realtime：同步表只订阅 INSERT、UPDATE（TC-B1-29），tombstones 只订阅 INSERT。返回取消函数 */
  subscribe(tables: readonly string[], h: RealtimeHandlers): () => void;
  /** 启动、切到前台时整行刷新 app_config、profiles 本人那一行（0.27 第 4 点） */
  fetchConfig(): Promise<NetResult<ConfigRows>>;
  reportTz(tz: string, deviceId: string, platform: string): Promise<NetResult<TzReportResult>>;
}

/**
 * 宽容读取（K7）：把服务器来的原始行变成能进本机库的行。
 * - rows：能用的行（带不认识的值的标 ro；隐私记行只留 cipherCols 和 neutralCols，A18）；
 * - bad：整行解析不了的 id（K8 记进 meta 的 refetch:<表>，下次启动单独补拉，TC-B1-38）。
 * 纯函数：不碰本机库、不联网；日志（row_unknown，不记内容）由 K7 自己在函数里交给日志层
 */
export interface ParsedRows {
  rows: ServerRowInput[];
  bad: string[];
}
export type ParseServerRows = (table: string, raw: readonly unknown[]) => ParsedRows;

export type SyncEvent =
  /** apply_patch 回 conflict / forked：界面提示“已在另一台设备上改过”，提供“看对方的版本”（4.4 第 5、6 条） */
  | {
      type: 'conflict';
      status: 'conflict' | 'forked';
      table: string;
      id: string;
      conflicts: readonly string[];
      old: Readonly<Record<string, unknown>> | null;
      /** forked 时冲突副本的 id（界面可跳过去看）；conflict 为 null */
      forkId: string | null;
    }
  /**
   * apply_patch 回 gone（一边删一边改）：这一项已按永久失败进“发送失败”区（outbox 同时发 error 事件，code = gone）。
   * 界面提示“这条已在另一台设备上删除”：“恢复并保留我的修改”= 新入队一个 deleted_at = null、undone = false 加上原修改的 patch，
   * 再 outbox.discard(opId)；“好的”= outbox.discard(opId)
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
