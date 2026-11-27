// kit 选择器（日期、时刻、下拉单选；kit/components/Pick，2026-11-21 换掉 iOS 系统框）的词条·中文。
// 只给编辑页按需下载的选择器用（kit/hooks/usePickT.ts），放在公共词典里会跟着首屏下载。加一条要同时加 pick-ko.ts
// as const：值保留字面量类型
export const pickZh = {
  'pick.clear': '清空',
  'pick.ok': '确定',
  'pick.prevWeek': '上一周',
  'pick.nextWeek': '下一周',
  'pick.ym': '{y}年{m}月',
  'pick.mm': '{a}月–{b}月',
  // 跨年那一周两头都带年份（评审第 14 条）
  'pick.yy': '{ya}年{a}月–{yb}年{b}月',
  // 日期格的读屏名字里加上“今天”（评审第 8 条）
  'pick.today': '今天',
  // 一周七天的单字，按星期几取（第 0 个是周日；一周从哪天排起跟日历设置走），格子上面的小字
  'pick.wd': '日一二三四五六',
  'pick.hour': '时',
  'pick.minute': '分',
  'pick.hourName': '{h} 时',
  'pick.minuteName': '{m} 分',
  // 点周标题弹出的月份列表（负责人 11-23）：列表读屏名、每年前面的小字、月份胶囊上的字
  'pick.months': '选月份',
  'pick.y': '{y}年',
  'pick.m': '{m}月',
  'pick.date': '选日期',
  'pick.time': '选时刻',
} as const;

export type PickMsgKey = keyof typeof pickZh;
