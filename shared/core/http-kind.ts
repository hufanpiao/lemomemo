// HTTP 状态码 → 归类（全仓只这一份；11-18 全 app 评审加密组第 5 条：原来隐私记、导出、附件检查、会话结局、交接设备行、恢复账号、
// 同步队列、文件上传、刷新令牌各写一张表，408、429 有的当稍后再试、有的当“出错”）
// • 只按状态码分；服务器的错误码（{error}）各功能先认，认不出再用这里
// • 口径：401 → auth（会话用不了）；426 → upgrade；429 → rate_limited；408、5xx（含 Supabase 的 546 WORKER_LIMIT）→ try_later；
//   404 → not_found；413 → too_large；2xx → ok；别的（含 0、负数这种没拿到响应的）→ client
// 纯 TS，不引别的模块（前端、Deno 函数、测试都能用）
export type HttpKind = 'ok' | 'auth' | 'upgrade' | 'rate_limited' | 'try_later' | 'not_found' | 'too_large' | 'client';

export function httpKind(status: number): HttpKind {
  if (status >= 200 && status <= 299) return 'ok';
  if (status === 401) return 'auth';
  if (status === 426) return 'upgrade';
  if (status === 429) return 'rate_limited';
  if (status === 408 || (status >= 500 && status <= 599)) return 'try_later';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  return 'client';
}

/** 稍后再试就可能好的（限流、超时、服务器忙） */
export const isRetryStatus = (status: number): boolean => {
  const k = httpKind(status);
  return k === 'rate_limited' || k === 'try_later';
};

/**
 * 前台一次操作里当场重试的退避（毫秒）：2 s、5 s、15 s 三次。附件和插图上传（core/row-sync.ts 的 PUT_BACKOFF）、
 * 隐私记队列和取图（features/vault/data/vault-queue.ts 的 QUEUE_BACKOFF）共用这一份（11-18 全 app 评审加密组第 8 条：原来两处各写一份）。
 * 同步队列的长退避是另一回事（core/outbox-logic.ts，跨启动、最长 5 分钟）
 */
export const RETRY_BACKOFF_MS = [2000, 5000, 15000] as const;
