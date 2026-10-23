// 相对日期文案：relDay()“今天 周五 / 明天 周六 / 10月30日 周五”，dueText()“晚了 2 天 / 今天截止 / 还剩 3 天”。
// 以当前日期 today() 为基准。不碰 document / window。
// 依赖：core/date.js。
App.logic = App.logic || {};

const {WK, parse, today, dayDiff, md} = App.core.date;

function relDay(s){
  const n = dayDiff(s, today());
  const w = WK[parse(s).getDay()];
  if (n === 0) return "今天 "+w; if (n === 1) return "明天 "+w; if (n === 2) return "后天 "+w;
  if (n === -1) return "昨天 "+w;
  return md(s)+" "+w;
}
function dueText(due){
  const n = dayDiff(due, today());
  if (n < 0) return "晚了 "+(-n)+" 天";
  if (n === 0) return "今天截止"; if (n === 1) return "明天截止";
  if (n <= 7) return "还剩 "+n+" 天";
  return md(due)+" 截止";
}

App.logic.format = {relDay, dueText};
