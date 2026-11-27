// 功能 calendar 的词典·中文：今日运势卡、详情和填生日那一层。
// 文字逐字照方案页 方案-八字-B.html 的 T.zh；卡片和详情里不出现术语。只给按需加载的运势卡用（ui/FortuneCard.tsx、FortuneSheet.tsx），不进日历页那一包
// 占位符中韩必须一致（__tests__/fortune-card.test.tsx 逐键比对）
export const fortuneZh = {
  'fortune.empty': '想按八字看每天的运势？',
  // 今天页没日程时组合区的“今日小运”小方块（today 的 TodayFun 经 index.ts 的 FortuneTile）
  'fortune.tile': '今日小运',
  // 网页版宽屏今天页的今日运势卡标题
  'fortune.day': '今日运势',
  'fortune.more': '看详情',
  'fortune.set': '填生日',
  'fortune.luckColor': '幸运色',
  'fortune.luckNum': '幸运数字',
  'fortune.meta.num': '幸运数字 {n}',
  'fortune.stars': '{n} 星（满分 5 星）',
  'fortune.catStars': '{cat} {n} 星（满分 5 星）',
  'fortune.cardLabel': '今日运势，你的本色{me}，{n} 星，{tip}幸运色{c}，幸运数字{k}',
  // 详情
  'fortune.detailTitle': '{me} · {m}月{d}日',
  'fortune.meLine': '你的本色是{me}：{desc}',
  'fortune.dayLine': '今天是你的{name} · 仅供娱乐，图个好心情',
  'fortune.edit': '改生日',
  'fortune.close': '关闭',
  // 填写层
  'fortune.cancel': '取消',
  'fortune.title': '你的生日',
  'fortune.ok': '确定',
  'fortune.y': '年',
  'fortune.m': '月',
  'fortune.d': '日',
  'fortune.h': '时',
  'fortune.hourUnknown': '不知道',
  'fortune.hour': '{a}–{b}点',
  'fortune.yearInput': '出生年份',
  'fortune.kpTip': '打两位就行：92 = 1992',
  // 打满四位但不在范围里（参考里没有这一句，照键盘提示同一个位置、同一种小字）
  'fortune.yearBad': '年份要在 {min}～{max} 之间',
  'fortune.kpClear': '清空',
  'fortune.kpDel': '删一位',
  'fortune.resWhen': '{y}年{m}月{d}日 · {h}',
  'fortune.resHourUnknown': '不知道几点',
  'fortune.resMe': '你的本色：',
  'fortune.pick': '选好年、月、日就能看',
  'fortune.clear': '清除生日',
  'fortune.store': '生日会同步到你的账号，可随时清除 · 仅供娱乐',
} as const;
