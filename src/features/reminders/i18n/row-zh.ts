// 功能 reminders 的词典·中文，首屏那几句：今天页“错过 N 条提醒 / 查看 ›”一行、“未同步”提示和行尾标记（首屏瘦身 H1 第三轮）
// 单独一个文件：首屏只下载这几句，不带整本提醒词典（zh.ts 里没有这几个键，只有 useRemindRowT 用）；占位符中韩一致由 __tests__/remind-i18n.test.ts 查
export const remindRowZh = {
  'remind.missed.row': '错过 {n} 条提醒',
  'remind.missed.open': '查看 ›',
  'remind.unsynced': '未同步，提醒可能不响',
  'remind.unsynced.mark': '未同步',
  'remind.unsynced.retry': '重试',
} as const;
