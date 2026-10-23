// 一句话解析 parseQuick(s, t, projectNames)：从“下周三下午两点半和 NEOX 对片”里取出
// 日期、时间、是否重要、项目和标题；有时间就判为日程，否则为待办。纯函数：
// “今天”由参数 t（"YYYY-MM-DD"）传入，项目名单由 projectNames 传入。依赖：core/date.js。
App.logic = App.logic || {};

const {pad, ymd, parse, addDays, mondayOf} = App.core.date;
const CN = {"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":0,"天":0};

function parseQuick(s, t, projectNames){
  // 中文数字转阿拉伯数字（只处理紧跟“点/月/日/号/分”的，避免误伤“周三”）
  const cnNum = w => {
    const D = {"零":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
    if (w === "十") return 10;
    if (w.includes("十")){ const [a,b] = w.split("十"); return (a ? D[a] : 1)*10 + (b ? D[b] : 0); }
    return D[w];
  };
  s = s.replace(/[零一二两三四五六七八九十]{1,3}(?=[点月日号分])/g, w => { const n = cnNum(w); return n == null ? w : String(n); });
  let text = " " + s + " ", date = "", time = "", important = false, project = "";
  const take = re => { const m = text.match(re); if (m) text = text.replace(m[0], " "); return m; };
  let m;
  if ((m = take(/(大后天|后天|明天|明早|明晚|今天|今晚|今早)/))){
    const w = m[1]; date = addDays(t, w === "大后天" ? 3 : w === "后天" ? 2 : w.startsWith("明") ? 1 : 0);
    if (w === "明晚" || w === "今晚") text = " 晚上" + text;
    if (w === "明早" || w === "今早") text = " 早上" + text;
  }
  else if ((m = take(/(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/))){
    let wd = CN[m[2]] != null ? CN[m[2]] : Number(m[2]) % 7;
    const cur = parse(t).getDay();
    const mon = mondayOf(t);
    const idx = (wd + 6) % 7;
    if (m[1] === "下") date = addDays(mon, 7 + idx);
    else if (m[1] === "下下") date = addDays(mon, 14 + idx);
    else if (m[1] === "这" || m[1] === "本") date = addDays(mon, idx);
    else { let diff = (wd - cur + 7) % 7; date = addDays(t, diff); }
  }
  else if ((m = take(/(?:(\d{4})[年\/.-])?(\d{1,2})[月\/.-](\d{1,2})[日号]?/))){
    const y = m[1] ? Number(m[1]) : parse(t).getFullYear();
    let d = new Date(y, Number(m[2])-1, Number(m[3]));
    if (!m[1] && ymd(d) < t) d = new Date(y+1, Number(m[2])-1, Number(m[3]));
    if (!isNaN(d)) date = ymd(d);
  }
  else if ((m = take(/(\d{1,2})[日号]/))){
    const n = parse(t); let d = new Date(n.getFullYear(), n.getMonth(), Number(m[1]));
    if (ymd(d) < t) d = new Date(n.getFullYear(), n.getMonth()+1, Number(m[1]));
    date = ymd(d);
  }
  if ((m = take(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})(?:[:：](\d{2})|点(?:钟)?(半|一刻|三刻|(\d{1,2})分?)?)/))){
    let hh = Number(m[2]), mm = m[3] ? Number(m[3]) : m[4] === "半" ? 30 : m[4] === "一刻" ? 15 : m[4] === "三刻" ? 45 : m[5] ? Number(m[5]) : 0;
    const p = m[1] || "";
    if ((p === "下午" || p === "傍晚" || p === "晚上") && hh < 12) hh += 12;
    if (p === "中午" && hh < 6) hh += 12;
    if (hh <= 23 && mm <= 59){ time = pad(hh)+":"+pad(mm); if (!date) date = t; }
  }
  take(/(凌晨|早上|上午|中午|下午|傍晚|晚上)/);
  if (take(/(重要|紧急|[!！]+)/)) important = true;
  for (const p of projectNames.slice().sort((a,b) => b.length - a.length)){
    const i = text.toLowerCase().indexOf(p.toLowerCase());
    if (i >= 0){ project = p; break; }
  }
  let title = text.replace(/\s+/g," ").trim().replace(/^(之前|以前|前)\s*/,"").replace(/^(在|要|得|记得|提醒我|帮我记一下|记一下)\s*/,"").replace(/^[，,。、\s]+|[，,。、\s]+$/g,"");
  if (!title) title = s.trim();
  return {title, date, time, important, project, kind: time ? "event" : "todo"};
}

App.logic.parseQuick = parseQuick;
