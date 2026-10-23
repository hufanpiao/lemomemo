// 职责：一句话解析 parseQuick(s, t, projectNames)（纯函数）：从“下周三下午两点半和 NEOX 对片”里取出日期、时间、
//       是否重要、项目和标题；有时间就判为日程，否则为待办。“今天”由 t（"YYYY-MM-DD"）传入。
//       分四步：中文数字 → 日期 → 时间 → 标记（重要）→ 项目 → 标题；每步从剩余文字里“取走”识别到的部分。
// 依赖：core/date.js
App.logic = App.logic || {};

const {pad, ymd, parse, addDays, mondayOf} = App.core.date;
const CN_WEEKDAY = {"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":0,"天":0};
const CN_DIGIT = {"零":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};

// 第 0 步：中文数字转阿拉伯数字（只处理紧跟“点/月/日/号/分”的，避免误伤“周三”）
function cnNum(w){
  if (w === "十") return 10;
  if (w.includes("十")){ const [a,b] = w.split("十"); return (a ? CN_DIGIT[a] : 1)*10 + (b ? CN_DIGIT[b] : 0); }
  return CN_DIGIT[w];
}
const digitize = s => s.replace(/[零一二两三四五六七八九十]{1,3}(?=[点月日号分])/g, w => { const n = cnNum(w); return n == null ? w : String(n); });

// 在剩余文字 st.text 里找 re，找到就把那一段换成空格，返回匹配结果
function take(st, re){ const m = st.text.match(re); if (m) st.text = st.text.replace(m[0], " "); return m; }

// 第 1 步：日期（今天/明天…、周几、几月几日、几号），返回 "YYYY-MM-DD" 或 ""
function takeDate(st, t){
  let m;
  if ((m = take(st, /(大后天|后天|明天|明早|明晚|今天|今晚|今早)/))){
    const w = m[1];
    if (w === "明晚" || w === "今晚") st.text = " 晚上" + st.text;
    if (w === "明早" || w === "今早") st.text = " 早上" + st.text;
    return addDays(t, w === "大后天" ? 3 : w === "后天" ? 2 : w.startsWith("明") ? 1 : 0);
  }
  if ((m = take(st, /(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/))){
    const wd = CN_WEEKDAY[m[2]] != null ? CN_WEEKDAY[m[2]] : Number(m[2]) % 7;
    const mon = mondayOf(t), idx = (wd + 6) % 7;
    if (m[1] === "下") return addDays(mon, 7 + idx);
    if (m[1] === "下下") return addDays(mon, 14 + idx);
    if (m[1] === "这" || m[1] === "本") return addDays(mon, idx);
    return addDays(t, (wd - parse(t).getDay() + 7) % 7);
  }
  if ((m = take(st, /(?:(\d{4})[年\/.-])?(\d{1,2})[月\/.-](\d{1,2})[日号]?/))){
    const y = m[1] ? Number(m[1]) : parse(t).getFullYear();
    let d = new Date(y, Number(m[2])-1, Number(m[3]));
    if (!m[1] && ymd(d) < t) d = new Date(y+1, Number(m[2])-1, Number(m[3]));
    return isNaN(d) ? "" : ymd(d);
  }
  if ((m = take(st, /(\d{1,2})[日号]/))){
    const n = parse(t); let d = new Date(n.getFullYear(), n.getMonth(), Number(m[1]));
    if (ymd(d) < t) d = new Date(n.getFullYear(), n.getMonth()+1, Number(m[1]));
    return ymd(d);
  }
  return "";
}

// 第 2 步：时间（上午/下午 + 几点几分 / 8:30），返回 "HH:MM" 或 ""；最后把单独剩下的“上午/晚上”等也取走
function takeTime(st){
  let time = "";
  const m = take(st, /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})(?:[:：](\d{2})|点(?:钟)?(半|一刻|三刻|(\d{1,2})分?)?)/);
  if (m){
    let hh = Number(m[2]);
    const mm = m[3] ? Number(m[3]) : m[4] === "半" ? 30 : m[4] === "一刻" ? 15 : m[4] === "三刻" ? 45 : m[5] ? Number(m[5]) : 0;
    const p = m[1] || "";
    if ((p === "下午" || p === "傍晚" || p === "晚上") && hh < 12) hh += 12;
    if (p === "中午" && hh < 6) hh += 12;
    if (hh <= 23 && mm <= 59) time = pad(hh)+":"+pad(mm);
  }
  take(st, /(凌晨|早上|上午|中午|下午|傍晚|晚上)/);
  return time;
}

// 第 3 步：标记（重要 / 紧急 / 感叹号）
const takeImportant = st => !!take(st, /(重要|紧急|[!！]+)/);

// 第 4 步：项目（名字长的优先，不分大小写）
function findProject(text, names){
  const low = text.toLowerCase();
  for (const p of names.slice().sort((a,b) => b.length - a.length)) if (low.indexOf(p.toLowerCase()) >= 0) return p;
  return "";
}

// 第 5 步：标题（去掉多余空白、开头的“前/之前”“记得/提醒我”等、首尾标点）
function cleanTitle(text, original){
  const title = text.replace(/\s+/g," ").trim().replace(/^(之前|以前|前)\s*/,"").replace(/^(在|要|得|记得|提醒我|帮我记一下|记一下)\s*/,"").replace(/^[，,。、\s]+|[，,。、\s]+$/g,"");
  return title || original.trim();
}

function parseQuick(s, t, projectNames){
  s = digitize(s);
  const st = {text: " " + s + " "};
  let date = takeDate(st, t);
  const time = takeTime(st);
  if (time && !date) date = t;
  const important = takeImportant(st);
  const project = findProject(st.text, projectNames);
  const title = cleanTitle(st.text, s);
  return {title, date, time, important, project, kind: time ? "event" : "todo"};
}

App.logic.parseQuick = parseQuick;
App.logic.parseQuickSteps = {digitize, takeDate, takeTime, takeImportant, findProject, cleanTitle};
