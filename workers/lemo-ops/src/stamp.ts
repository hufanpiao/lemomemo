// 邮件里的时刻写法：负责人在韩国（UTC+9），给首尔时间；同时写 UTC，方便对日志。alerts.ts、mail-fail.ts 共用。
// fmtAge（时长写法）10-31 从 rules.ts 挪来，rules.ts、orphans.ts 共用（rules.ts 照旧导出它）。

export function stamp(ms: number, ko = false): string {
  const kst = new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const utc = new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  return ko ? `${kst} (서울) / ${utc} UTC` : `${kst}（首尔） / ${utc} UTC`;
}

/** 秒数写成“x 小时 y 分”这种给人看的样子 */
export function fmtAge(s: number): string {
  const total = Math.max(0, Math.floor(s / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 48) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}
