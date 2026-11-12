// 错误的类型名：前端只在这里取（11-13 FA-3 第二轮第 7 条：recorder、speech、perm-mic、http、save-file、env、sw-register、push-test、plus 的 send-error 都调这里）
// • errName：name 是字符串就原样给，不然空串；AbortError、TimeoutError（取消、超时）只在 isAbortErr 判
// • errTag：进运行日志的“ type=<名>”片段，只收字母。从 run-log-api.ts 挪出（Q-5，11-12）
// 错误的 message 可能带用户内容，一律不取

/** 错误的类型名（TypeError、NotAllowedError 等）；不是带字符串 name 的对象给空串 */
export function errName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : '';
}

/** 是不是取消、超时（AbortError、TimeoutError） */
export function isAbortErr(err: unknown): boolean {
  const n = errName(err);
  return n === 'AbortError' || n === 'TimeoutError';
}

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串 */
export function errTag(err: unknown): string {
  const n = errName(err);
  return /^[A-Za-z]{1,40}$/.test(n) ? ` type=${n}` : '';
}
