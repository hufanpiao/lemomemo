// 时区的通俗说法·中文（11-05 从公共词典 zh.ts 挪出来，首屏瘦身）：shared/i18n/tz-label.ts 按时区名挑键，
// 邮件（account、account-purge 经 _shared/gen 注入）和登录页的恢复页（auth.restore.when 的 {zone}）共用；主 App 首屏用不到，
// 放在公共词典里会跟着首屏下载（约 0.3 KB gzip）。KO-mail-nolink-tz，韩文复核“账号信防钓鱼与时区”3.3 节的固定表。
// 加一条要同时加 tz-ko.ts，并在 tz-label.ts 的 switch 里挑它（F7：只用字面量键）
// as const：值保留字面量类型
export const tzZh = {
  'tz.kr': '韩国时间',
  'tz.cn': '北京时间',
  'tz.jp': '日本时间',
  'tz.hk': '香港时间',
  'tz.tw': '台北时间',
  'tz.sg': '新加坡时间',
  'tz.th': '泰国时间',
  'tz.vn': '越南时间',
  'tz.usEast': '美国东部时间',
  'tz.usCentral': '美国中部时间',
  'tz.usMountain': '美国山地时间',
  'tz.usWest': '美国西部时间',
  'tz.hawaii': '夏威夷时间',
  'tz.uk': '英国时间',
  'tz.cet': '欧洲中部时间',
  'tz.auEast': '澳大利亚东部时间',
} as const;

/** 时区词条的键 */
export type TzMsgKey = keyof typeof tzZh;
