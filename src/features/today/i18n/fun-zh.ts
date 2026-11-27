// 功能 today 的词典·中文：今天页没日程时的组合区（ui/TodayFun.tsx；定稿 方案4.html 组合区）。跟着 TodayFun 按需下载，不进首屏
// 文字逐字照定稿：“今天空着，要不要把它做了？”“没定日期 · 3 天前记的”“放进今天”“这周做完”“9 件”“比上周 +3”；
// 星期一个字一根柱，顺序 日 一 二 三 四 五 六（本周柱子从周日起）
export const todayFunZh = {
  'fun.quickQ': '今天空着，要不要把它做了？',
  'fun.quickMeta': '没定日期 · {n} 天前记的',
  'fun.quickMetaToday': '没定日期 · 今天记的',
  'fun.quickGo': '放进今天',
  'fun.quickGoLabel': '放进今天：{title}',
  'fun.week': '这周做完',
  'fun.weekUnit': '件',
  'fun.weekUp': '比上周 +{n}',
  'fun.weekDown': '比上周 −{n}',
  'fun.weekSame': '和上周一样',
  'fun.wd': '日一二三四五六',
  'fun.weekLabel': '这周做完 {n} 件，{vs}。每天：{days}',
  'fun.weekDay': '{w} {n} 件',
} as const;
