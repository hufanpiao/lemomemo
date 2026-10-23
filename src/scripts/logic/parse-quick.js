// 职责：一句话解析 parseQuick(s, t, projectNames)（纯函数）：从“下周三下午两点半和 NEOX 对片”“내일 오후 3시 NEOX 미팅”
//       里取出日期、时间、是否重要、项目、提醒和标题；有时间就判为日程，否则为待办。“今天”由 t（"YYYY-MM-DD"）传入。
//       步骤：预处理 → 提醒说法 → 日期（中文、韩文）→ 时间 → 重要 → 项目 → 标题，每步从剩余文字里“取走”识别到的部分。
// 依赖：core/date.js、logic/parse-text.js、logic/parse-date-zh.js、logic/parse-date-ko.js、logic/parse-time.js、logic/parse-marks.js
App.logic = App.logic || {};

const {addDays} = App.core.date;
const {prepare} = App.logic.parseText;
const {takeDateZh} = App.logic.parseDateZh;
const {takeDateKo} = App.logic.parseDateKo;
const {takeTime, takeStrayPeriod} = App.logic.parseTime;
const {takeRemind, takeImportant, findProject, cleanTitle} = App.logic.parseMarks;

/*
 * 返回 {title, date, time, important, project, kind, remind}
 *   title：什么都没剩下时用原话
 *   kind：有时间为 "event"，否则 "todo"；“N点前 / N시까지”记成当天截止的待办，时间写进标题（“交稿 18:00前”）
 *   remind：null 没提到；{off:true} 不提醒；{min:N} 提前 N 分钟（日程说“提前1天”换成 {min:1440}）；{days:N} 待办提前 N 天
 */
function parseQuick(s, t, projectNames){
  const x = prepare(s);
  const st = {text: " " + x + " "};
  let remind = takeRemind(st);
  const d = takeDateKo(st, t) || takeDateZh(st, t) || {date:"", period:""};
  const tm = takeTime(st, d.period);
  let date = d.date;
  if ((tm.time || tm.deadline) && !date) date = t;
  if (tm.nextDay) date = addDays(date || t, 1);
  takeStrayPeriod(st);
  const important = takeImportant(st);
  const project = findProject(st.text, projectNames);
  const core = cleanTitle(st.text);
  const title = tm.deadline ? (core ? core + " " + tm.deadline : tm.deadline) : (core || s.trim());
  const kind = tm.time ? "event" : "todo";
  if (remind && remind.days != null && kind === "event") remind = {min: remind.days * 1440};
  return {title, date, time: tm.time, important, project, kind, remind};
}

App.logic.parseQuick = parseQuick;
