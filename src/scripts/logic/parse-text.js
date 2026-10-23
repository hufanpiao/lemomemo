// 职责：一句话解析的文字预处理与公共工具（纯函数）：全角数字和标点转半角、中文星期先改成数字（防止“周五十点”被读成 50）、
//       中文数字转阿拉伯数字（“两点”“二十五分”“十一月”“三点二十”）、韩文固有数词转数字（“세 시”→“3시”）、
//       take()/cut() 从剩余文字里取走一段、cnNum() 中文数字换算。
// 依赖：无
App.logic = App.logic || {};

const CN_DIGIT = {"零":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
const CN_WEEKDAY = {"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":7,"天":7};
const KO_NATIVE = {"한":1,"두":2,"세":3,"네":4,"다섯":5,"여섯":6,"일곱":7,"여덟":8,"아홉":9,"열":10,"열한":11,"열두":12};

// “十”“十五”“二十”“两”→ 数字；认不出返回 undefined
function cnNum(w){
  if (/^\d+$/.test(w)) return Number(w);
  if (w === "十") return 10;
  if (w.includes("十")){ const [a,b] = w.split("十"); return (a ? CN_DIGIT[a] : 1)*10 + (b ? CN_DIGIT[b] : 0); }
  return CN_DIGIT[w];
}
// 全角数字、冒号、空格转半角（听写和中文输入法常出全角）
const toHalfWidth = s => s.replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/：/g, ":").replace(/[　 ]/g, " ");
// 周X / 星期X / 礼拜X 的“X”先换成 1–7（7＝周日），后面的中文数字转换就不会把“周五十点”读成“50 点”
const protectWeekdays = s => s.replace(/(周|星期|礼拜)([一二三四五六日天])/g, (m, a, b) => a + CN_WEEKDAY[b]);
// 中文数字转阿拉伯数字：只处理紧跟“点/月/日/号/分”的，以及“N点”后面的分钟（“三点二十”），避免误伤普通词
function digitize(s){
  const conv = w => { const n = cnNum(w); return n == null ? w : String(n); };
  s = s.replace(/[零一二两三四五六七八九十]{1,3}(?=\s*[点月日号分])/g, conv);
  return s.replace(/点([零一二两三四五六七八九十]{1,3})(?![刻])/g, (m, w) => "点" + conv(w));
}
// 韩文固有数词 + 시：“세 시”“열한 시”→“3시”“11시”（不碰“시간”“시작”）
const koNative = s => s.replace(/(?<![\uAC00-\uD7A3])(열한|열두|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네)\s*시(?![간작])/g, (m, w) => KO_NATIVE[w] + "시");

// 在剩余文字 st.text 里找 re，找到就把那一段换成空格，返回匹配结果
function take(st, re){ const m = st.text.match(re); if (m) st.text = st.text.replace(m[0], " "); return m; }
// 把已经找到的那段文字（字符串）从 st.text 里取走
function cut(st, str){ st.text = st.text.replace(str, " "); }

// 一句话最多 300 字（安全复审：超长输入会让几条正则变慢）；连续空白先合并成一个
const QUICK_MAX = 300;
function prepare(s){ s = String(s).slice(0, QUICK_MAX).replace(/\s+/g, " "); return koNative(digitize(protectWeekdays(toHalfWidth(s)))); }

App.logic.parseText = {cnNum, toHalfWidth, protectWeekdays, digitize, koNative, take, cut, prepare, QUICK_MAX};
