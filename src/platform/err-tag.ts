// 进运行日志的错误类型名（录音 recorder.ts、手机自带识别 speech.ts 用）
// 从 run-log-api.ts 挪出（Q-5，11-12）：run-log-api 在首屏块里，errTag 放那边，只要有懒加载的页面用到它（录音探测页经 recorder.ts），
// 就会跟着进首屏（实测 +91 B gzip）；放这里只进用到它的懒加载块

/** 进日志的错误类型名：` type=<名>`，只收字母；认不出返回空串。错误的 message 可能带用户内容，不记 */
export function errTag(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? (err as { name: unknown }).name : null;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? ` type=${name}` : '';
}
