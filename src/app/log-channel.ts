// 本页的日志通道（接手清单 K8-logs、K6-log；数据字典 4.6、架构 0.38 第 62、67 条）：同步层、outbox、时区上报、设备登记都把日志交到这一个函数
// • 写 logs 表的那一端是 core/log/queue.ts（localStorage 队列、主页批量上传，架构 0.38 第 68 条），main.tsx 用 setSink 接上；
//   接上以前（启动早期）先在内存里留最近 LOG_BUFFER_MAX 条，setSink 那一刻按顺序交出去，之后直接转交
// • 这里不加工内容：各处调用时就只给 act、coll、code（outbox_vault_shell_drop 另有 itemId），不放内容、sqlerrm、服务器原文
// • outboxLog：outbox 的 log 参数形状不同（R-229 空壳丢队列项），在这里转成同一条通道：coll = 表名、itemId = 记录 id、code = 丢掉的条数
import type { LogRecord } from '../core/log/queue.ts';
import type { OutboxOptions } from '../core/outbox-types.ts';
import type { SyncLog } from '../core/sync/types.ts';
import { clearLogQueue } from '../platform/log-store.ts';

export const LOG_BUFFER_MAX = 200;

/** 一条日志（act、coll、code、itemId 和记下的时刻） */
export type LogEntry = LogRecord;

export interface LogChannel {
  log: SyncLog;
  /** 接上写 logs 表的那一端：先按顺序交出缓存的，之后直接转交。sink 抛错不影响调用方 */
  setSink(sink: (e: LogEntry) => void): void;
  /** 测试用：还没交出去的 */
  pending(): readonly LogEntry[];
}

export function createLogChannel(opts: { now?: () => number; max?: number } = {}): LogChannel {
  const now = opts.now ?? (() => Date.now());
  const max = opts.max ?? LOG_BUFFER_MAX;
  const buf: LogEntry[] = [];
  let sink: ((e: LogEntry) => void) | null = null;
  const give = (e: LogEntry): void => {
    try {
      sink?.(e);
    } catch {
      // 日志出错不挡业务
    }
  };
  return {
    log(act, f) {
      const e: LogEntry = { act, t: now() };
      if (f?.coll) e.coll = f.coll;
      if (f?.code) e.code = f.code;
      if (f?.itemId) e.itemId = f.itemId;
      if (sink) return give(e);
      buf.push(e);
      if (buf.length > max) buf.shift();   // 只留最近的
    },
    setSink(s) {
      sink = s;
      for (const e of buf.splice(0)) give(e);
    },
    pending: () => [...buf],
  };
}

/** outbox 的 log（R-229 outbox_vault_shell_drop）接到同一条通道：表名、记录 id、丢掉的条数（logs 没有数字列，写进 code） */
export function outboxLog(log: SyncLog): NonNullable<OutboxOptions['log']> {
  return (e) => log(e.act, { coll: e.coll, itemId: e.id, code: String(e.dropped) });
}

/**
 * 停掉并清掉这个账号的日志上传队列（架构 0.38 第 68 条；被移除、停用、注销冷静期、本页收到 SIGNED_OUT）：main.tsx 交给 watchAccount 和 wireSync 共用。
 * close 立刻生效（之后不记、不传、在途那一批传完也不写回），所以先同步清一次，不打乱后面清本机、回登录页的顺序；等在途那一批收尾后再清一次兜底
 */
export function logQueueCleaner(
  queue: { close(): Promise<unknown> },
  userId: string,
  clear: (userId: string) => void = (id) => clearLogQueue(id),
): () => void {
  return () => {
    const closing = queue.close();
    clear(userId);
    void closing.then(
      () => clear(userId),
      () => clear(userId),
    );
  };
}
