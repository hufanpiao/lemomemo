// 邮件里的时刻写法：负责人在韩国（UTC+9），给首尔时间；同时写 UTC，方便对日志。alerts.ts、mail-fail.ts 共用。

export function stamp(ms: number, ko = false): string {
  const kst = new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const utc = new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  return ko ? `${kst} (서울) / ${utc} UTC` : `${kst}（首尔） / ${utc} UTC`;
}
