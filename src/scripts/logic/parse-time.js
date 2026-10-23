// 职责：一句话解析的时间（纯函数），中文和韩文共用一套规则：
//       时段词（上午/下午/晚上/凌晨…、오전/오후/저녁/밤/새벽/아침/점심）+ N点[半/一刻/三刻/N分] / N:MM / N시[반/N분]；
//       没写时段时 1–6 点按下午（澄清#11，含冒号写法和韩文）；“今晚12点”“밤 12시”是次日 00:00（澄清#9、9.2-10）；
//       “N点前 / N시까지”是截止（澄清#10），返回 deadline 文案，由调用方记成当天截止的待办。
//       认不出的时间（如“25点”）原样留在文字里，不取走。返回 {time, deadline, nextDay}。
// 依赖：core/date.js、logic/parse-text.js
App.logic = App.logic || {};

const {pad} = App.core.date;
const {cut} = App.logic.parseText;

const MORNING = ["凌晨","早上","早晨","上午","오전","새벽","아침"];
const NOON = ["中午","점심","낮"];
const EVENING = ["下午","傍晚","晚上","오후","저녁"];
const NIGHT = ["夜里","半夜","深夜","밤"];
const PERIODS = MORNING.concat(NOON, EVENING, NIGHT);
const TIME_RE = new RegExp(
  "(" + PERIODS.join("|") + ")?\\s*(\\d{1,2})" +
  "(?:\\s*:\\s*(\\d{2})" +                                                  // 8:30
  "|\\s*点(?:钟)?(半|一刻|三刻|(\\d{1,2})\\s*分?)?" +                         // 3点 / 3点半 / 3点20 / 3点25分
  "|\\s*시(?![간작])(?:\\s*(반)|\\s*(\\d{1,2})\\s*분)?)" +                   // 3시 / 3시 반 / 3시 30분
  "(\\s*(?:之前|以前|前|까지))?(?:에(?![\uAC00-\uD7A3]))?");                         // 截止、助词“에”

// period：时段词；hint：日期词带出的时段（“今晚”→“晚上”）。返回 {hh, nextDay}
function applyPeriod(hh, period, hint){
  const p = period || hint || "";
  if (MORNING.includes(p)) return {hh: hh === 12 && (p === "오전" || p === "새벽" || p === "凌晨") ? 0 : hh, nextDay:false};
  if (NOON.includes(p)) return {hh: hh < 6 ? hh + 12 : hh, nextDay:false};
  if (NIGHT.includes(p) || (p === "晚上" && hh === 12)){
    if (hh === 12) return {hh:0, nextDay:true};
    if (hh >= 1 && hh <= 5 && p !== "晚上") return {hh, nextDay:true};
    return {hh: hh < 12 ? hh + 12 : hh, nextDay:false};
  }
  if (EVENING.includes(p)) return {hh: hh < 12 ? hh + 12 : hh, nextDay:false};
  return {hh: hh >= 1 && hh <= 6 ? hh + 12 : hh, nextDay:false};   // 没写时段：1–6 点按下午
}

function takeTime(st, hint){
  const m = st.text.match(TIME_RE);
  if (!m) return {time:"", deadline:"", nextDay:false};
  const raw = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : m[4] === "半" || m[6] ? 30 : m[4] === "一刻" ? 15 : m[4] === "三刻" ? 45 : m[5] ? Number(m[5]) : m[7] ? Number(m[7]) : 0;
  if (raw > 24 || mm > 59) return {time:"", deadline:"", nextDay:false};   // 认不出：不取走，留在标题里
  const {hh, nextDay} = applyPeriod(raw, m[1], hint);
  if (hh > 23) return {time:"", deadline:"", nextDay:false};
  cut(st, m[0]);
  const time = pad(hh) + ":" + pad(mm);
  if (m[8]) return {time:"", deadline: time + (m[8].includes("까지") ? "까지" : "前"), nextDay};
  return {time, deadline:"", nextDay};
}
// 时间之外单独剩下的中文时段词（“下午”）从标题去掉；韩文的“저녁 약속”“점심 미팅”是标题的一部分，保留
function takeStrayPeriod(st){ const m = st.text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)/); if (m) cut(st, m[0]); }

App.logic.parseTime = {takeTime, applyPeriod, takeStrayPeriod, TIME_RE};
