// 职责：一句话解析的标记与收尾（纯函数）：提醒说法（“提前半小时提醒”“不用提醒”“30분 전 알림”“알림 없이”）、
//       重要（只认“重要/紧急/중요/급함”这类词，“不重要/안 중요”不算，感叹号不算，澄清#15）、
//       项目匹配（英文项目名前后不能紧挨英文字母或数字）、标题整理（去多余空白、首尾标点、感叹号、“记得/提醒我”等开头）。
// 依赖：logic/parse-text.js
App.logic = App.logic || {};

const {cnNum, take} = App.logic.parseText;

// 提醒说法。返回 {off:true} / {min:N} / {days:N} / null（没提到）
function takeRemind(st){
  let m;
  if (take(st, /(?:不用|不要|无需|不需要|别)\s*提醒|不提醒|알림\s*(?:없이|없음|끄기|안\s*함)/)) return {off:true};
  if ((m = take(st, /提前\s*(半|[\d零一二两三四五六七八九十]+)\s*个?\s*(分钟|分|小时|钟头|天|日)\s*提醒(?:我)?/))){
    const unit = m[2], n = m[1] === "半" ? 0.5 : cnNum(m[1]);
    if (n == null) return null;
    if (unit === "天" || unit === "日") return n >= 1 ? {days: Math.round(n)} : {min: Math.round(n * 1440)};
    return {min: Math.round(unit === "小时" || unit === "钟头" ? n * 60 : n)};
  }
  if ((m = take(st, /(\d+)\s*(분|시간)\s*전(?:에)?\s*알림/))) return {min: Number(m[1]) * (m[2] === "시간" ? 60 : 1)};
  if ((m = take(st, /(하루|이틀|(\d+)\s*일)\s*전(?:에)?\s*알림/))) return {days: m[1] === "하루" ? 1 : m[1] === "이틀" ? 2 : Number(m[2])};
  return null;
}

// 重要。“不重要的事”这类修饰用法：不标重要，标题保留（9.2-12）；单独的“不重要 / 안 중요”：不标重要，从标题去掉
const KEEP = ["不重要的", "不紧急的"];
const MARK = i => "〔保留" + i + "〕";
function takeImportant(st){
  KEEP.forEach((w, i) => { st.text = st.text.split(w).join(MARK(i)); });   // 先藏起来，免得被下面的规则拆掉
  take(st, /不重要|不紧急|안\s*(?:중요|급)(?:함|해|한)?/);
  const hit = !!take(st, /重要的?|紧急的?|중요한|중요(?:함|해)?|급함|급해|긴급/);
  KEEP.forEach((w, i) => { st.text = st.text.split(MARK(i)).join(w); });
  return hit;
}

const isWordChar = c => /[A-Za-z0-9]/.test(c);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 项目：名字长的优先、不分大小写；英文名前后不能紧挨英文字母或数字（“UI”不会命中“GUI”）
function findProject(text, names){
  for (const p of names.slice().sort((a,b) => b.length - a.length)){
    if (!p) continue;
    const re = new RegExp((isWordChar(p[0]) ? "(?<![A-Za-z0-9])" : "") + esc(p) + (isWordChar(p[p.length - 1]) ? "(?![A-Za-z0-9])" : ""), "i");
    if (re.test(text)) return p;
  }
  return "";
}

// 标题：去掉感叹号、多余空白、首尾标点，以及开头的“前/之前”（“周五前交”）和“记得/提醒我”等口头语
const EDGE = /^[\s，,。.、；;:？?]+|[\s，,。.、；;:？?]+$/g;
function cleanTitle(text){
  let s = text.replace(/[!！]+/g, " ").replace(/\s+/g, " ");
  s = s.replace(/\s*([，,。、；;])(?:\s*[，,。、；;])+/g, "$1").replace(EDGE, "");
  s = s.replace(/^(之前|以前|前)\s*/, "").replace(/^(在|要|得|记得|提醒我|帮我记一下|记一下)\s*/, "").replace(EDGE, "");
  return s;
}

App.logic.parseMarks = {takeRemind, takeImportant, findProject, cleanTitle};
