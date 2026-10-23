// 职责：一句话解析的韩文日期（纯函数）：오늘/내일/모레/글피、월요일~일요일（이번 주/다음 주/다다음 주，按周一开头）、
//       N월 N일、N일；后面带的“까지”（截止）和助词“에”一并取走。“今天”由参数 t 传入。返回 {date} 或 null。
// 依赖：core/date.js、logic/parse-text.js、logic/parse-date-zh.js
App.logic = App.logic || {};

const {addDays, parse} = App.core.date;
const {take, cut} = App.logic.parseText;
const {monthDay, dayOnly, weekday} = App.logic.parseDateZh;

const KO_WEEKDAY = {"월":1,"화":2,"수":3,"목":4,"금":5,"토":6,"일":7};
const KO_REL = {"오늘":0,"내일":1,"모레":2,"글피":3};
// 日期后面可以跟“까지”（截止）或助词“에”
const TAIL = "(?:\\s*까지)?(?:에(?![\uAC00-\uD7A3]))?";

function takeDateKo(st, t){
  let m;
  if ((m = take(st, new RegExp("(오늘|내일|모레|글피)" + TAIL)))) return {date: addDays(t, KO_REL[m[1]])};
  if ((m = take(st, new RegExp("(다다음\\s*주|다음\\s*주|담주|이번\\s*주)?\\s*(월|화|수|목|금|토|일)요일" + TAIL)))){
    const p = (m[1] || "").replace(/\s+/g, "");
    const prefix = p === "다음주" || p === "담주" ? "下" : p === "다다음주" ? "下下" : p === "이번주" ? "这" : "";
    return {date: weekday(t, prefix, KO_WEEKDAY[m[2]])};
  }
  if ((m = st.text.match(new RegExp("(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일(?![요간])" + TAIL)))){
    const date = monthDay(t, parse(t).getFullYear(), Number(m[1]), Number(m[2]), false);
    if (date){ cut(st, m[0]); return {date}; }
  }
  if ((m = st.text.match(new RegExp("(?<![\\d.])(\\d{1,2})\\s*일(?![요간])" + TAIL)))){
    const date = dayOnly(t, Number(m[1]));
    if (date){ cut(st, m[0]); return {date}; }
  }
  return null;
}

App.logic.parseDateKo = {takeDateKo};
