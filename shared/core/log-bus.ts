// 业务日志总线（写 logs 表的日志只经这里，架构约定 10.1）：各层（platform、kit、core、功能、app）用 logEvent 记一条，
// 入口（src/app/main.tsx）用 setLogSink 接一次上传队列。接上以前记的先在内存留最近 LOG_EARLY_MAX 条，接上那一刻按顺序交出去。
// 不变量：只交 act 和 coll / code / itemId（不放内容、服务器原文）；error 只交错误对象，由 sink 换成“类型@文件名:行号”；
// logEvent 不抛（sink 出错吞掉）；时刻由 sink 打（shared 里不取“现在”）

export interface LogFields {
  coll?: string;
  code?: string;
  itemId?: string;
  /** 出错的那个错误对象：sink 换成 code（jsErrorCode），不原样上传 */
  error?: unknown;
}

export type LogSink = (act: string, f?: LogFields) => void;

/** 接上 sink 以前最多留几条（只留最近的） */
export const LOG_EARLY_MAX = 200;

let sink: LogSink | null = null;
const early: Array<[string, LogFields | undefined]> = [];

/** 记一条业务日志 */
export function logEvent(act: string, f?: LogFields): void {
  if (!sink) {
    early.push([act, f]);
    if (early.length > LOG_EARLY_MAX) early.shift();
    return;
  }
  try {
    sink(act, f);
  } catch {
    // 日志出错不挡业务
  }
}

/** 入口接上写 logs 表的那一端（null 断开，测试用）：先按顺序交出接上以前记的 */
export function setLogSink(s: LogSink | null): void {
  sink = s;
  if (s) for (const [act, f] of early.splice(0)) logEvent(act, f);
}

/** 测试用：清掉还没交出去的 */
export function resetLogBusForTest(): void {
  sink = null;
  early.length = 0;
}
