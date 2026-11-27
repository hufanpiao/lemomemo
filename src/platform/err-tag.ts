// 进运行日志的错误类型名；名字本身取 env.ts 的 errName（前端只那一份）
// 不放 run-log-api.ts：那边在首屏块里，放这里只进用到它的懒加载块
import { errName } from './env.ts';

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串。错误的 message 可能带用户内容，不记 */
export function errTag(err: unknown): string {
  const n = errName(err);
  return /^[A-Za-z]{1,40}$/.test(n) ? ` type=${n}` : '';
}
