// 职责：一句话解析的中文日期（纯函数）：今天/明天/后天/大后天（今晚、明早带出时段提示）、周几（这/下/下下周）、
//       下个月 N 号、带年份的日期、N月N日、M/D、N号/N日。“3号楼”“3.5万”“版本1.5”“第3-5集”都不当日期。
//       “今天”由参数 t 传入。返回 {date, period} 或 null（period 是“今晚”带出的“晚上”这类时段提示）。
// 依赖：core/date.js、logic/parse-text.js
App.logic = App.logic || {};

const {ymd, parse, addDays, mondayOf} = App.core.date;
const {take, cut} = App.logic.parseText;

// 没写年份的月日：已经过去就算明年
function monthDay(t, y, mo, d, hasYear){
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let x = new Date(y, mo - 1, d);
  if (!hasYear && ymd(x) < t) x = new Date(y + 1, mo - 1, d);
  return ymd(x);
}
// 只写了几号：本月已过就算下个月
function dayOnly(t, d){
  if (d < 1 || d > 31) return null;
  const n = parse(t); let x = new Date(n.getFullYear(), n.getMonth(), d);
  if (ymd(x) < t) x = new Date(n.getFullYear(), n.getMonth() + 1, d);
  return ymd(x);
}
// 周几：wd 为 1–7（7＝周日）；prefix 为 下/下下/这/本 或空（空＝从今天起最近的那一天，今天是周五时“周五”指今天）
function weekday(t, prefix, wd){
  const mon = mondayOf(t), idx = (wd + 6) % 7, js = wd % 7;
  if (prefix === "下") return addDays(mon, 7 + idx);
  if (prefix === "下下") return addDays(mon, 14 + idx);
  if (prefix === "这" || prefix === "本") return addDays(mon, idx);
  return addDays(t, (js - parse(t).getDay() + 7) % 7);
}

function takeDateZh(st, t){
  const y = parse(t).getFullYear();
  let m;
  if ((m = take(st, /(大后天|后天|明天|明早|明晚|今天|今晚|今早)/))){
    const w = m[1];
    const period = w.endsWith("晚") ? "晚上" : w.endsWith("早") ? "早上" : "";
    return {date: addDays(t, w === "大后天" ? 3 : w === "后天" ? 2 : w.startsWith("明") ? 1 : 0), period};
  }
  if ((m = take(st, /(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([1-7])/))) return {date: weekday(t, m[1], Number(m[2]))};
  if ((m = take(st, /下个?月\s*(\d{1,2})\s*[日号](?![楼栋室])/))){
    const n = parse(t), d = Number(m[1]);
    return d >= 1 && d <= 31 ? {date: ymd(new Date(n.getFullYear(), n.getMonth() + 1, d))} : null;
  }
  if ((m = st.text.match(/(\d{4})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*[日号]?/))){
    const date = monthDay(t, Number(m[1]), Number(m[2]), Number(m[3]), true);
    if (date){ cut(st, m[0]); return {date}; }
  }
  // N月N日：“十一月三号”在预处理时已变成“11月3号”
  if ((m = st.text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?(?![楼栋室])/))){
    const date = monthDay(t, y, Number(m[1]), Number(m[2]), false);
    if (date){ cut(st, m[0]); return {date}; }
  }
  // M/D（12/25）；用“.”“-”分隔的必须带“日/号”，否则“3.5万”“版本1.5”“第3-5集”会被误认
  if ((m = st.text.match(/(?<![\d.\/])(\d{1,2})\/(\d{1,2})(?![\d\/.])/) || st.text.match(/(?<![\d.第])(\d{1,2})[.\-](\d{1,2})[日号]/))){
    const date = monthDay(t, y, Number(m[1]), Number(m[2]), false);
    if (date){ cut(st, m[0]); return {date}; }
  }
  // N号 / N日：“3号楼”“3号线”“5号院”不算
  if ((m = st.text.match(/(?<![\d.第])(\d{1,2})\s*[日号](?![楼栋室线院间])/))){
    const date = dayOnly(t, Number(m[1]));
    if (date){ cut(st, m[0]); return {date}; }
  }
  return null;
}

App.logic.parseDateZh = {takeDateZh, monthDay, dayOnly, weekday};
