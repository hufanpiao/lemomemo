// i18n-exempt: 解析词表
// 重复说法（R-163；架构 5.1“重复说法”、0.29 续第 70、151 条；B3 任务单 S9、BE-2；TC-B3-30、31、62）：
//   • recurHint(text)：按原话（语音用 ai-voice 返回的转写）判断有没有“每周 / 每天 / 每月 / 每个月 / 每年 / 매주 / 매일 / 매달 / 매월 / 매년”
//     这类说法。带重复说法的句子本机规则一律算“没把握”，在线、有同意、有额度时交给 AI；提示条加“重复要等新版本，这次只记了最近一次”。
//     AI 输出结构不加字段，这个判断只在本机做（AI 路也按原话调它出提示）。
//   • takeRecur(st)：本机规则自己记的时候，认出具体的重复说法，算“现在以后的第一次”：
//     每天 → 今天（说了时刻、今天这个时刻已过 → 明天）；每周X → 最近的周X（今天就是周X、时刻已过 → 下周）；
//     每月N号 → 本月N号（已过 → 下个月，下个月没有这一天就再往后找）；每年M月D日 → 今年（已过 → 明年）。
//     重复说法连同里面的具体日子留在标题里（“每个月15号交水费”“每周一开周会”），只有几点几分拿去填 time；date_basis 一律 rel。
//   4.0.0 不写 repeat 列。纯函数，“今天”和“现在第几分钟”由调用方传。
import { addDays, daysIn, fmtDateStr, weekdayOf, type DateStr } from '../../core/date.ts';
import { pick, type Rest, weekdayZh } from './text.ts';

/** 原话里有没有重复说法（不需要预处理，中韩都认） */
const RECUR_RE = /每\s*(?:个\s*)?(?:天|日|周|星期|礼拜|月|年)|天天|매\s*(?:일|주|달|월|년)/;

export function recurHint(text: string): boolean {
  return RECUR_RE.test(text);
}

/** 认出的具体重复说法：display 是留在标题里的那一段；next(time) 给出最近一次的日子 */
export interface RecurMatch {
  display: string;
  /** 每年 M 月 D 日：给纪念日用（“每年10月28日是结婚纪念日”纪念日优先，TC-B3-62 ④） */
  md?: { month: number; day: number };
  next(today: DateStr, nowMin: number, timeMin: number | null): DateStr;
}

const KO_WD: Readonly<Record<string, number>> = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };

/** 已过：日子是今天、说了时刻、时刻不晚于现在 */
const passedToday = (nowMin: number, timeMin: number | null): boolean => timeMin !== null && timeMin <= nowMin;

function daily(display: string): RecurMatch {
  return { display, next: (today, nowMin, t) => (passedToday(nowMin, t) ? addDays(today, 1) : today) };
}

/** wd：1–7（7 = 周日） */
function weekly(display: string, wd: number): RecurMatch {
  return {
    display,
    next(today, nowMin, t) {
      const js = wd % 7;
      const diff = (js - weekdayOf(today) + 7) % 7;
      if (diff === 0 && passedToday(nowMin, t)) return addDays(today, 7);
      return addDays(today, diff);
    },
  };
}

function monthly(display: string, day: number): RecurMatch {
  return {
    display,
    next(today, nowMin, t) {
      let y = Number(today.slice(0, 4));
      let m = Number(today.slice(5, 7));
      for (let i = 0; i < 24; i++) {
        if (day <= daysIn(y, m)) {
          const cand = fmtDateStr(y, m, day);
          if (cand > today || (cand === today && !passedToday(nowMin, t))) return cand;
        }
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
      return today;
    },
  };
}

function yearly(display: string, month: number, day: number): RecurMatch {
  return {
    display,
    md: { month, day },
    next(today, nowMin, t) {
      let y = Number(today.slice(0, 4));
      for (let i = 0; i < 9; i++, y++) {
        if (day > daysIn(y, month)) continue;
        const cand = fmtDateStr(y, month, day);
        if (cand > today || (cand === today && !passedToday(nowMin, t))) return cand;
      }
      return today;
    },
  };
}

/**
 * 从预处理过的剩余文字里认出具体的重复说法并取走（换成占位，标题里原样放回 display）。
 * 认不出具体日子的（只说“每周”“매주”）返回 null，交给 recurHint 判“没把握”。
 */
export function takeRecur(st: Rest): RecurMatch | null {
  const rules: [RegExp, (m: RegExpMatchArray) => RecurMatch | null][] = [
    [/每\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/, (m) => yearlyOk(m[0], Number(m[1]), Number(m[2]))],
    [/매\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (m) => yearlyOk(m[0], Number(m[1]), Number(m[2]))],
    [/每\s*(?:个\s*)?月\s*(\d{1,2})\s*[号日]/, (m) => monthlyOk(m[0], Number(m[1]))],
    [/매\s*(?:달|월)\s*(\d{1,2})\s*(?:일|号|日)/, (m) => monthlyOk(m[0], Number(m[1]))],
    [/每\s*(?:个\s*)?(?:周|星期|礼拜)\s*([1-7])/, (m) => weekly(m[0].replace(/[1-7]$/, (d) => weekdayZh(Number(d))), Number(m[1]))],
    [/매\s*주\s*(월|화|수|목|금|토|일)요일/, (m) => weekly(m[0], pick(KO_WD, m[1] ?? '') ?? 1)],
    [/每\s*(?:天|日)|天天/, (m) => daily(m[0])],
    [/매\s*일(?![요간])/, (m) => daily(m[0])],
  ];
  for (const [re, make] of rules) {
    const m = st.text.match(re);
    if (!m) continue;
    const r = make(m);
    if (!r) continue;
    st.text = st.text.replace(m[0], RECUR_MARK);
    return r;
  }
  return null;
}

/** 标题里重复说法的占位（私用区字符，别的正则碰不到） */
export const RECUR_MARK = String.fromCharCode(0xe000);

function yearlyOk(display: string, month: number, day: number): RecurMatch | null {
  if (month < 1 || month > 12 || day < 1 || day > ([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].at(month - 1) ?? 0)) return null;
  return yearly(display, month, day);
}

function monthlyOk(display: string, day: number): RecurMatch | null {
  return day >= 1 && day <= 31 ? monthly(display, day) : null;
}
