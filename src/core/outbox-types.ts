// 离线写入队列的类型和接口（架构 4.2、0.27 第 1 点）：K7、K8 和 data 层的 write.* 按这里的类型接
// 实现在 outbox.ts（createOutbox），纯函数在 outbox-logic.ts
// 纯 TS：不准 import React 和任何功能（A1）
import type { OutboxPause, ServerRow } from './cache.ts';
import type { Manifest } from './manifest.ts';
import type { OutboxMigration } from './outbox-migrations.ts';

export type OutboxOp = 'insert' | 'patch';
export type OutboxState = 'pending' | 'inflight' | 'failed';

/** 指向一条记录 */
export interface RecRef {
  table: string;
  id: string;
}

/** 队列项（4.2 的格式；v、app 见 0.27；seq、rec、remind、deps、error 是本机用的辅助字段） */
export interface OutboxItem {
  /** 幂等键：apply_patch 用它去重（applied_ops） */
  op_id: string;
  table: string;
  id: string;
  /** `${table}:${id}`（outbox 仓的索引） */
  rec: string;
  op: OutboxOp;
  /** insert：整行可写列；patch：只放改了的列 */
  data: Record<string, unknown>;
  /** patch 时看到的服务器 rev（insert 为 null；排在还没确认的 insert 后面的 patch 也先是 null，insert 确认后补上） */
  base_rev: number | null;
  /** 这条记录在 base_rev 之后由本机写出来的 rev（最多 20 个，超过清空，按冲突处理） */
  own_revs: number[];
  /** 入队时的本机时间（epoch ms），不参与冲突判断 */
  client_ts: number;
  /** 已经失败（transient）的次数；upgrade、auth 不计 */
  tries: number;
  /** 退避：这个时间（epoch ms）之前不发 */
  next_at: number;
  state: OutboxState;
  /** 队列项格式版本（outbox-migrations.ts 的 OUTBOX_V） */
  v: number;
  /** 入队时的 App 版本 */
  app: string;
  /** 全局先进先出的序号（同一个事务里取 max + 1） */
  seq: number;
  /** 带提醒（本机现算的 remind_at 不为空，4.5）：整条记录提前发，界面标“未同步，提醒可能不响” */
  remind: boolean;
  /** 依赖的记录：这些记录还在队列里时，本项不会排到它们前面（note_images → notes，从随手记转的待办 → 原随手记） */
  deps: RecRef[];
  /** 永久失败的错误码（state = failed 时） */
  error: string | null;
}

/** 入队参数 */
export interface EnqueueInput {
  table: string;
  id: string;
  op: OutboxOp;
  /** insert：整行可写列（含 id）；patch：只放改了的列。按 shared/schema/rows.ts 的严格版或清单的可写列校验 */
  data: Record<string, unknown>;
  /** 带提醒（调用方用 shared 的 remindAtOf 本机现算） */
  remind?: boolean;
  deps?: readonly RecRef[];
}

/** apply_patch / insert 的确认（K8 从响应里取） */
export interface AckResult {
  status: 'ok' | 'conflict' | 'forked';
  /** 改完以后的 rev */
  rev: number;
  /** 改之前的 rev；insert 为 null */
  prev_rev: number | null;
}

/** 发送失败的信息（K8 从响应里取） */
export interface SendFailure {
  /** HTTP 状态；断网、超时不填 */
  status?: number;
  /** 响应体或 PostgREST 的错误码 */
  code?: string;
  /** 426 响应体里的 min（platform/http.ts 的 readUpgradeRequired） */
  min?: string | null;
  /** 断网、超时 */
  network?: boolean;
}

/**
 * 失败归类：
 * - upgrade：426 / upgrade_required，整个队列暂停；
 * - auth：401、令牌过期，刷新令牌后重发，不计 tries。**本层不限次数**：K8 负责刷新失败或连续 401 时停下（走退出登录），不能无限重发；
 * - transient：断网、5xx、429，退避重发；
 * - permanent：其他 4xx、校验失败，进“发送失败”区并回滚 view；
 * - drop：vault_required、settings_key_immutable、not_found（apply_patch 找不到这一行），丢掉这一项，调用方整表重拉；
 * - removed：session_revoked、account_disabled（被移除或被停用），队列设闸、发 removed 事件，调用方清空本机、回登录页
 */
export type FailureKind = 'upgrade' | 'auth' | 'transient' | 'permanent' | 'drop' | 'removed';

/** 队列状态（界面：“有 N 条没同步上”、“有 N 条等更新后同步”、未同步提醒的小标记）；不变时引用不变 */
export interface OutboxStatus {
  /** pending + inflight */
  pending: number;
  failed: number;
  /** 因 426 暂停；界面显示“有 N 条等更新后同步 · 内容还在本机” */
  paused: OutboxPause | null;
  /** 带提醒、还没同步上的记录（`${table}:${id}`） */
  remindRecs: ReadonlySet<string>;
}

export type OutboxEvent =
  /** 永久失败：已回滚 view，这一项进“发送失败”区 */
  | { type: 'error'; item: OutboxItem; code: string }
  /** 被服务器拒收并丢掉（vault_required 等）：调用方整表重拉这张表、写 logs outbox_rejected */
  | { type: 'rejected'; item: OutboxItem; code: string }
  /** 426：整个队列已暂停 */
  | { type: 'upgrade_required'; min: string | null }
  /** 被移除（session_revoked、account_disabled）：队列已设闸；调用方清空本机（session.ts 的 clearLocalSession 兜底删会话）、回登录页 */
  | { type: 'removed'; code: string };

/** 启动时整理队列的结果 */
export interface OutboxBootReport {
  /** 改成当前格式的项数 */
  migrated: number;
  /** 比当前格式高、留着不发的项数 */
  future: number;
  /** 迁移失败、留着不发的项数（记日志，不删） */
  stuck: number;
  /** 上次没发完（inflight）复位成 pending 的项数（op_id 幂等，重发没问题） */
  reset: number;
  /** 426 暂停还在（版本没变）；版本变了已自动解除 */
  paused: OutboxPause | null;
}

/** 服务器来的一行（K8 拉取 / Realtime；K7 宽容读取后给出 ro） */
export interface ServerRowInput {
  row: ServerRow;
  /** 带不认识的值：只读 */
  ro?: boolean;
}

/**
 * 离线写入队列。K8、data 层 write.* 统一规则：任何方法抛 CacheClosedError（core/cache.ts）都表示库已封存或已关
 * （换账号、被移除、别的标签页升级本机库），当作“停下”处理，不重试、不弹错误提示
 */
export interface Outbox {
  /** 启动时调一次（在发送之前）：队列项迁移、inflight 复位、版本变了就解除 426 暂停 */
  boot(): Promise<OutboxBootReport>;
  /**
   * 写入（data 层的 write.* 都走这里）：校验 → 同一个事务里改 view、入队 → 通知集合。
   * 返回队列项；和前面没发的 insert 抵消时返回 null。被拒时抛 OutboxRejectError（readonly_row、row_missing、invalid_row……）
   */
  enqueue(input: EnqueueInput): Promise<OutboxItem | null>;
  /**
   * 取下一项来发并标成 inflight；暂停中、设了闸、已有一项在发、没有可发的时返回 null。
   * K8 注意：每发一项之前、每处理一个响应之前，先看闸（isSuspended() 或 boot.switching），设了就停，不发、不写回。
   * 换账号、被移除时库会被封存（Cache.seal）并随后关库：这时 enqueue、next、ack、fail、applyServer 等都可能抛 CacheClosedError
   * （查闸和设闸之间、或请求在路上时）。调用方当作“正在换账号或被移除”直接停下：不重试、不报错、不记日志，页面马上会重新载入
   */
  next(): Promise<OutboxItem | null>;
  /** 发送成功 */
  ack(opId: string, ack: AckResult): Promise<void>;
  /** 发送失败；返回归类 */
  fail(opId: string, failure: SendFailure): Promise<FailureKind>;
  /** 丢掉一项并回滚 view（“发送失败”区的丢弃、gone 时选“好的”） */
  discard(opId: string): Promise<void>;
  /** “发送失败”区的重试：改回 pending、清 tries，重新叠加到 view */
  retryFailed(opIds?: readonly string[]): Promise<void>;
  /** 切到前台、上线：清掉退避等待，马上能发 */
  clearBackoff(): Promise<void>;
  /** 解除 426 暂停（一般不用手调：新版启动时 boot() 自动解除） */
  resume(): Promise<void>;
  /** 服务器来的行：更新 server，再把还没确认的项叠上去得到 view（4.3 rebase）；比本机旧的 rev 忽略 */
  applyServer(table: string, rows: readonly ServerRowInput[]): Promise<void>;
  /** 服务器上已经硬删的行（墓碑、30 天清理）：删本机行和它还在队列里的项 */
  dropServer(table: string, ids: readonly string[]): Promise<void>;
  list(): Promise<OutboxItem[]>;
  getStatus(): OutboxStatus;
  subscribe(listener: () => void): () => void;
  onEvent(fn: (e: OutboxEvent) => void): () => void;
  /** 重新读队列算状态（别的标签页改了队列时） */
  refresh(): Promise<void>;
  /**
   * 设闸（换账号、被移除；core/account.ts 的 watchAccount 同步调）：之后 enqueue 抛 OutboxRejectError('outbox_suspended')，
   * next 返回 null，ack、fail、discard、retryFailed、clearBackoff、resume、applyServer、dropServer 什么也不做。不能解除（随后关库、重新载入）
   */
  suspend(): void;
  isSuspended(): boolean;
}

export interface OutboxOptions {
  /** 默认构建版本 */
  appVersion?: string;
  now?: () => number;
  newOpId?: () => string;
  manifests?: readonly Manifest[];
  migrations?: readonly OutboxMigration[];
  currentV?: number;
}

/** SW 记下的通知按键（0.29 续第 107 条；形状由 B2 的 SW 定，这里只认这几项） */
export interface PendingAction {
  id: string;
  user_id: string;
  /** epoch ms */
  created_at: number;
  action: unknown;
}
