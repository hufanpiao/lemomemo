// 职责：界面文案的纯函数：relDay()“今天 周五 / 明天 周六 / 10月30日 周五”，dueText()“晚了 2 天 / 今天截止 / 还剩 3 天”，
//       startsText()“1 小时 20 分钟后开始 / 进行中，19:30 结束”。“今天”由参数 t 传入。
// 依赖：core/const.js、core/date.js
App.logic = App.logic || {};

const C = App.core.C;
const {WK, parse, dayDiff, md, m2hm} = App.core.date;

function relDay(s, t){
  const n = dayDiff(s, t);
  const w = WK[parse(s).getDay()];
  if (n === 0) return "今天 "+w; if (n === 1) return "明天 "+w; if (n === 2) return "后天 "+w;
  if (n === -1) return "昨天 "+w;
  return md(s)+" "+w;
}
function dueText(due, t){
  const n = dayDiff(due, t);
  if (n < 0) return "晚了 "+(-n)+" 天";
  if (n === 0) return "今天截止"; if (n === 1) return "明天截止";
  if (n <= C.DUE_COUNTDOWN_DAYS) return "还剩 "+n+" 天";
  return md(due)+" 截止";
}
// mins：离开始还有几分钟（≤0 表示已开始）；end：结束时刻（当天分钟数）
function startsText(mins, end){
  if (mins <= 0) return "进行中，"+m2hm(end)+" 结束";
  if (mins < 60) return mins+" 分钟后开始";
  return Math.floor(mins/60)+" 小时 "+(mins%60 ? mins%60+" 分钟" : "")+"后开始";
}

App.logic.format = {relDay, dueText, startsText};
