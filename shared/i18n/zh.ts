// 公共词典·中文（架构 2.4）：服务器也要用的词条（推送文案、错误码、公共按钮）和日期格式
// 键名按“页面.用途”，参数写成 {name}。只在某个功能界面上用的词条放 src/features/<功能>/i18n/
// as const：值保留字面量类型，t() 才能按占位符推导参数
export const zh = {
  'app.name': '柠檬记',
  'common.ok': '好',
  'common.cancel': '取消',
  'common.retry': '重试',
  'common.close': '关闭',
  'error.unknown': '出了点问题，请稍后再试',
  'error.offline': '现在没有网络',
  'update.required': '需要更新才能继续同步 · 你记下的内容都还在本机',
  'update.available': '柠檬记有新版本',
  'update.reopen': '重新打开',
  'remind.push.event': '{time} {title}',
  'fmt.monthDay': '{m}月{d}日',
  'fmt.monthDayWeek': '{m}月{d}日 {w}',
  'fmt.wd.0': '周日',
  'fmt.wd.1': '周一',
  'fmt.wd.2': '周二',
  'fmt.wd.3': '周三',
  'fmt.wd.4': '周四',
  'fmt.wd.5': '周五',
  'fmt.wd.6': '周六',
} as const;
