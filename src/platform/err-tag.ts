// 进运行日志的错误类型名（录音 recorder.ts、手机自带识别 speech.ts 用）；名字本身取 env.ts 的 errName（前端只那一份，FA-3 第二轮第 7 条）
// 从 run-log-api.ts 挪出（Q-5，11-12）：run-log-api、env 在首屏块里，errTag 放那边会跟着进首屏（实测 +91 B gzip）；放这里只进用到它的懒加载块
import { errName } from './env.ts';

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串。错误的 message 可能带用户内容，不记 */
export function errTag(err: unknown): string {
  const n = errName(err);
  return /^[A-Za-z]{1,40}$/.test(n) ? ` type=${n}` : '';
}
