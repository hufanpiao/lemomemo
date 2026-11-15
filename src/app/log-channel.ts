// 日志总线（shared/core/log-bus.ts）接到 logs 上传队列的那一端（数据字典 4.6、架构 0.38 第 62、67、68 条）：main.tsx 用 setLogSink 接一次 toLogRecord
// • 这里不加工内容：各处只给 act、coll、code、itemId；error 只换成“错误类型@文件名:行号”（jsErrorCode），不放内容、sqlerrm、服务器原文
// • outboxLog：outbox 的 log 参数形状不同（R-229 空壳丢队列项），在这里转成同一条总线：coll = 表名、itemId = 记录 id、code = 丢掉的条数
import type { LogRecord } from '../core/log/queue.ts';
import type { OutboxOptions } from '../core/outbox-types.ts';
import type { SyncLog } from '../core/sync/types.ts';
import type { LogFields, LogSink } from '../../shared/core/log-bus.ts';
import { jsErrorCode } from '../platform/env.ts';
import { clearLogQueue } from '../platform/log-store.ts';

/** 总线上的一条 → 上传队列的一条：打上时刻 t；空的 coll / code / itemId 不带，error 换成 code */
export function toLogRecord(act: string, f: LogFields | undefined, t: number, origin: string = location.origin): LogRecord {
  const e: LogRecord = { act, t };
  if (f?.coll) e.coll = f.coll;
  const code = f?.code ?? (f && 'error' in f ? jsErrorCode(f.error, {}, origin) : undefined);
  if (code) e.code = code;
  if (f?.itemId) e.itemId = f.itemId;
  if (f?.fields?.length) e.fields = f.fields;
  return e;
}

/**
 * main.tsx 接到总线上的 sink：每条进上传队列，同一条也抄一行进运行日志（一键复制那份，正式版 rlog 是空操作）。
 * 以前业务日志（宽容读取丢行 row_unknown、quiet_error 等）只上传、本机看不到，11-16 牙医复诊排查只能翻本机库才查到
 */
export function logSink(queue: { add(r: LogRecord): void }, rlog: (line: string) => void, now: () => number = Date.now): LogSink {
  return (act, f) => {
    const r = toLogRecord(act, f, now());
    queue.add(r);
    rlog(`log ${act}${r.coll ? ` coll=${r.coll}` : ''}${r.code ? ` code=${r.code}` : ''}${r.itemId ? ` id=${r.itemId.slice(0, 8)}` : ''}${r.fields ? ` cols=${r.fields.join(',')}` : ''}`);
  };
}

/** outbox 的 log（R-229 outbox_vault_shell_drop）接到同一条总线：表名、记录 id、丢掉的条数（logs 没有数字列，写进 code） */
export function outboxLog(log: SyncLog): NonNullable<OutboxOptions['log']> {
  return (e) => log(e.act, { coll: e.coll, itemId: e.id, code: String(e.dropped) });
}

/**
 * 停掉并清掉这个账号的日志上传队列（架构 0.38 第 68 条；被移除、停用、注销冷静期、本页收到 SIGNED_OUT）：main.tsx 交给 lossExit（core/device-exit.ts 的 exitOnSessionLoss）和 wireSync 共用。
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
