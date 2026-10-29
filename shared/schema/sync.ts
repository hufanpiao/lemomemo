// 同步的线上形状（架构 4.3b“同步传输层放在 platform”、0.38 第 58 条）：和数据库 RPC、PostgREST、Realtime 的约定，前端和 Edge Functions 共用
// • zod 写、z.infer 推类型（2.5）；apply_patch 的 status 枚举照 4.4.1
// • 接口 SyncTransport 留在 core（src/core/sync/types.ts），参数和返回值只引这里的类型；platform 的实现不 import core（由 app 层注入）
import { z } from 'zod';
import type { Tables } from '../db.types.ts';

/** 网络失败（outbox 认得的结构）：HTTP 状态、错误码、426 的 min、断网 */
export const sendFailure = z.object({
  /** HTTP 状态；断网、超时不填 */
  status: z.number().int().optional(),
  /** 响应体或 PostgREST 的错误码（plpgsql raise exception 的码在 message 里，传输层已取出） */
  code: z.string().optional(),
  /** 426 响应体里的 min */
  min: z.string().nullable().optional(),
  /** 断网、超时 */
  network: z.boolean().optional(),
  /** 服务器给的 sqlstate（apply_patch 的 patch_bad_args 从 details 里取出），只用于记日志；服务器原文不带出来（0.38 第 62 条） */
  detail: z.string().regex(/^[0-9A-Z]{5}$/).optional(),
});
export type SendFailure = z.infer<typeof sendFailure>;

/** 网络调用的结果：成功带值，失败带 SendFailure */
export type NetResult<T> = { ok: true; value: T } | { ok: false; error: SendFailure };

/** apply_patch 的参数（4.4 的签名，参数名和 SQL 一致） */
export const patchArgs = z.object({
  p_table: z.string(),
  p_id: z.string(),
  p_patch: z.record(z.string(), z.unknown()).readonly(),
  p_base_rev: z.number().int().nullable(),
  p_op_id: z.string(),
  p_own_revs: z.array(z.number().int()).readonly(),
});
export type PatchArgs = z.infer<typeof patchArgs>;

/**
 * apply_patch 的返回（4.4.1：{status, rev, prev_rev, conflicts?, old?, fork_id?}）。
 * gone = 行在、已软删、patch 不含 deleted_at（可恢复）；not_found = 行没了或本人看不到，丢掉这一项（rev 为 null，规整成 0）
 */
export const patchResponse = z.object({
  status: z.enum(['ok', 'conflict', 'forked', 'gone', 'not_found']),
  rev: z.number().int().nullable().transform((v) => v ?? 0),
  prev_rev: z.number().int().nullable().optional().transform((v) => v ?? null),
  /** 冲突的字段（conflict、forked） */
  conflicts: z.array(z.string()).readonly().optional(),
  /** 冲突字段在服务器上的旧值（“看对方的版本”） */
  old: z.record(z.string(), z.unknown()).readonly().nullable().optional(),
  /** forked：另存的“（冲突副本）”那条随手记的 id */
  fork_id: z.string().optional(),
});
export type PatchResponse = z.output<typeof patchResponse>;

/** 增量 / 整表拉取的一页：按 (synced_at, id) 升序，after 是上一页最后一行（键集翻页） */
export const pullQuery = z.object({
  /** synced_at >= since（已经退过 10 分钟）；null = 整表 */
  since: z.string().nullable(),
  after: z.object({ synced_at: z.string(), id: z.string() }).nullable(),
  limit: z.number().int().positive(),
});
export type PullQuery = z.infer<typeof pullQuery>;

/** 墓碑一行（public.tombstones，只放 id；deleted_at 是 timestamptz 原文） */
export const tombstoneRow = z.object({ tbl: z.string(), id: z.string(), deleted_at: z.string() });
export type TombstoneRow = z.infer<typeof tombstoneRow>;

export const tombstoneQuery = z.object({
  since: z.string().nullable(),
  after: z.object({ deleted_at: z.string(), tbl: z.string(), id: z.string() }).nullable(),
  limit: z.number().int().positive(),
});
export type TombstoneQuery = z.infer<typeof tombstoneQuery>;

/** report_tz 的返回（迁移 20261029192000；rate_limited 见接手清单 K8-tz-rl） */
export const tzReportResult = z.enum(['accepted', 'pending', 'unchanged', 'fixed', 'phone_priority', 'rate_limited']);
export type TzReportResult = z.infer<typeof tzReportResult>;

/**
 * 刷新令牌的结果（TC-B1-88）：network = 断网、5xx、429（临时故障）；removed = session_not_found、refresh_token_not_found、
 * 403 含 session_revoked；failed = 别的 4xx（调用方记日志再试一次，两次都失败才按被移除）或本机没有会话
 */
export type SessionCheck = 'ok' | 'network' | 'removed' | 'failed';

export type RealtimeStatus = 'up' | 'down';

export interface RealtimeHandlers {
  /** 同步表的 INSERT / UPDATE（payload.new 原样，交给宽容读取） */
  onRow(table: string, raw: unknown): void;
  /** tombstones 的 INSERT */
  onTombstone(raw: unknown): void;
  /** 连上（SUBSCRIBED）/ 断了（CHANNEL_ERROR、TIMED_OUT、CLOSED） */
  onStatus(s: RealtimeStatus): void;
}

/** 启动、切到前台时整行刷新的 app_config、profiles 本人那一行（服务器的行原样；core 自己转成缓存类型） */
export interface ConfigRows {
  config: Tables<'app_config'> | null;
  profile: Tables<'profiles'> | null;
}
