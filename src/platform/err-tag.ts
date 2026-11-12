// 错误的类型名，前端只在这里取（FA-3 第二轮第 7 条；取消、超时只在 isAbortErr 判）；errTag 11-12 从 run-log-api.ts 挪出（Q-5）。
// 错误的 message 可能带用户内容，一律不取

/** 错误的类型名（TypeError 等）；没有字符串 name 给空串 */
export function errName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : '';
}

/** 是不是取消、超时（AbortError、TimeoutError） */
export const isAbortErr = (err: unknown): boolean => ['AbortError', 'TimeoutError'].includes(errName(err));

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串 */
export const errTag = (err: unknown): string => (/^[A-Za-z]{1,40}$/.test(errName(err)) ? ` type=${errName(err)}` : '');
