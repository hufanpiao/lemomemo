// i18n-exempt: 解析词表
// 本机规则的时刻（B3 任务单 BE-2；移植 v3 parse-time.js；架构 5.1 R-165、R-183，第 7 节“待办有截止时刻”）：
//   时段词（上午 / 下午 / 晚上 / 凌晨…、오전 / 오후 / 저녁 / 밤 / 새벽 / 아침 / 점심）+ N点[半 / 一刻 / 三刻 / N分] / N:MM / N시[반 / 半 / N분]；
//   没写时段时 1–6 点按下午（v3 澄清 #11）；“今晚12点”“밤 12시”是次日 00:00（v3 澄清 #9）；
//   “今晚 / 晚上 + 1～5 点”“밤 1～5시”是第二天凌晨（代码审 M1：原来按晚上 + 12 记成当天 13～17 点）；
//   没说日子的“凌晨 / 새벽 N 点”已经过了的，由 parse-split 记到明天（要看现在几点，这里不读时钟）；
//   “N点前 / N시까지”是截止时刻（R-183）：记成待办，time 填截止时刻、从标题去掉（v3 是把时刻写进标题，这里改了）；
//   “两点到四点 / 2시부터 4시까지”是起止：取开始时刻、时长 = 两者之差（K09：这里的“4시까지”是结束，不是截止）；
//   开始在晚上（18 点以后）、结束在凌晨（6 点以前）的按跨到第二天算（代码审 M2：“晚上11点到凌晨1点”是 120 分钟）；
//   “十点不对十一点 / 열 시 아니다 열한 시”是改口：以后说的为准（Z37、K39、M34）。
//   没有具体时刻、只有时段词的（R-165）：takePeriodOnly 取走时段词，调用方记成那天截止的待办；
//   时段词本身就是吃饭这件事的不取：“吃午饭”里没有时段词；韩文“점심 먹기 / 저녁 먹기 / 저녁 식사 / 아침 식사”留着（TC-B3-34）；
//   时段词后面接别的名词（약속、운동、회의……）的“점심 약속”“저녁 약속”“아침 운동”“점심 회의”一律去掉（R-165、续第 73 条，TC-B3-54；
//   架构审第九节 7a：不再给“점심 약속”开特例）。没有具体时刻时句末的时段词也去掉（M28“和老李 점심”→“和老李”、当天截止的待办，R-165）。
//   认不出的时间（如“25点”）原样留在文字里。
//   中文相对时刻（R-374，11-10 负责人“只加中文”）：takeRelative 认“N 分钟后 / N 小时后 / N 个小时后 / 半小时后 / 一个半小时后 / N 个半小时后 /
//   N 小时 M 分钟后 / 一刻钟后 / 过 N 分钟”（后、以后、之后、过后都算），返回从现在起多少分钟，由 parse-split 按 now 换成日子和时刻；
//   最多 72 小时，超了不认、原样留在标题里。“开会两小时”这种不带“后 / 过”的是时长，不认。韩文不做。
import { fmtHm } from '../../core/date.ts';
import { cnNum, type Rest } from './text.ts';

const MORNING = ['凌晨', '早上', '早晨', '上午', '오전', '새벽', '아침'];
const NOON = ['中午', '점심', '낮'];
const EVENING = ['下午', '傍晚', '晚上', '오후', '저녁'];
const NIGHT = ['夜里', '半夜', '深夜', '밤'];
const PERIODS = [...MORNING, ...NOON, ...EVENING, ...NIGHT];

/** 一个时刻：7 组（时段、时、冒号分、点后缀、点后分、시半、시分） */
const ONE =
  '(' + PERIODS.join('|') + ')?\\s*(\\d{1,2})' +
  '(?:\\s*:\\s*(\\d{2})' +
  '|\\s*点(?:钟)?(半|一刻|三刻|(\\d{1,2})\\s*分?)?' +
  '|\\s*시(?![간작])(?:\\s*(반|半)|\\s*(\\d{1,2})\\s*분)?)';
const PARTICLE = '(?:에(?![\\uAC00-\\uD7A3]))?';
const RANGE_RE = new RegExp(ONE + '\\s*(?:到|至|~|-|부터)\\s*' + ONE + '(?:\\s*까지)?' + PARTICLE);
const FIX_RE = new RegExp(ONE + '\\s*[,，]?\\s*(?:不对|不是|아니다|아니고|아니)\\s*[,，]?\\s*' + ONE + PARTICLE);
const SINGLE_RE = new RegExp(ONE + '(\\s*(?:之前|以前|前|까지))?' + PARTICLE);

interface Raw {
  per: string;
  hh: number;
  mm: number;
}

function rawAt(m: RegExpMatchArray, o: number): Raw {
  const g = (i: number) => m.at(o + i);
  const mm = g(2) ? Number(g(2)) : g(3) === '半' || g(5) ? 30 : g(3) === '一刻' ? 15 : g(3) === '三刻' ? 45 : g(4) ? Number(g(4)) : g(6) ? Number(g(6)) : 0;
  return { per: g(0) ?? '', hh: Number(g(1)), mm };
}

/** period：时段词；hint：日期词或前一件带出的时段。返回 24 小时制的时和是否跨到次日 */
export function applyPeriod(hh: number, period: string, hint: string): { hh: number; nextDay: boolean } {
  const p = period || hint || '';
  if (MORNING.includes(p)) return { hh: hh === 12 && (p === '오전' || p === '새벽' || p === '凌晨') ? 0 : hh, nextDay: false };
  if (NOON.includes(p)) return { hh: hh < 6 ? hh + 12 : hh, nextDay: false };
  if (NIGHT.includes(p) || p === '晚上') {
    if (hh === 12) return { hh: 0, nextDay: true };
    if (hh >= 1 && hh <= 5) return { hh, nextDay: true };   // 今晚 1 点 = 第二天 01:00（代码审 M1）
    return { hh: hh < 12 ? hh + 12 : hh, nextDay: false };
  }
  if (EVENING.includes(p)) return { hh: hh < 12 ? hh + 12 : hh, nextDay: false };
  return { hh: hh >= 1 && hh <= 6 ? hh + 12 : hh, nextDay: false };
}

export interface TimeHit {
  /** HH:MM；截止时刻也放这里（deadline 为 true） */
  time: string;
  deadline: boolean;
  /** 说了起止时的时长（分钟），没说为 null */
  duration: number | null;
  nextDay: boolean;
  /** 这一句里写明的时段词（下一件没写时段时沿用） */
  period: string;
}

function toMin(r: Raw, hint: string): { min: number; nextDay: boolean } | null {
  if (r.hh > 24 || r.mm > 59) return null;
  const { hh, nextDay } = applyPeriod(r.hh, r.per, hint);
  if (hh > 23) return null;
  return { min: hh * 60 + r.mm, nextDay };
}

/** 取走一句里的时刻（先认起止、改口，再认单个时刻）；hint 是日期词或前一件带出的时段 */
export function takeTime(st: Rest, hint: string): TimeHit | null {
  let m = st.text.match(RANGE_RE);
  if (m) {
    const a = rawAt(m, 1);
    const b = rawAt(m, 8);
    const s = toMin(a, hint);
    // 结束没写时段：沿用开始的时段；还是早于开始就按下午再试一次（“10点到2点”）
    let e = toMin({ ...b, per: b.per || a.per }, hint);
    if (s && e && e.min <= s.min && !b.per) e = toMin({ ...b, per: '下午' }, '');
    if (s && e) {
      st.text = st.text.replace(m[0], ' ');
      // 跨午夜（代码审 M2）：开始 18 点以后、结束 6 点以前，结束算第二天
      const overnight = e.min <= s.min && s.min >= 18 * 60 && e.min <= 6 * 60;
      const dur = e.min > s.min ? e.min - s.min : overnight ? e.min + 1440 - s.min : null;
      return { time: fmtHm(s.min), deadline: false, duration: dur, nextDay: s.nextDay, period: a.per || hint };
    }
  }
  m = st.text.match(FIX_RE);
  if (m) {
    const a = rawAt(m, 1);
    const b = rawAt(m, 8);
    const e = toMin({ ...b, per: b.per || a.per }, hint);
    if (e) {
      st.text = st.text.replace(m[0], ' ');
      return { time: fmtHm(e.min), deadline: false, duration: null, nextDay: e.nextDay, period: b.per || a.per || hint };
    }
  }
  m = st.text.match(SINGLE_RE);
  if (!m) return null;
  const r = rawAt(m, 1);
  const t = toMin(r, hint);
  if (!t) return null;   // 认不出：不取走，留在标题里
  st.text = st.text.replace(m[0], ' ');
  return { time: fmtHm(t.min), deadline: Boolean(m[8]), duration: null, nextDay: t.nextDay, period: r.per || hint };
}

/** 只有时段词、没说几点（R-165）：取走时段词，返回它；是事由的不取（见文件头） */
const ZH_PERIOD_RE = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜|深夜)/;
const KO_PERIOD_RE = /(오전|오후|아침|점심|저녁|새벽|밤|낮)(?:에(?:는)?)?(?![가-힣])/;
const KO_KEEP_RE = /^(?:점심|저녁|아침)\s*(?:먹|식사)/;

export function takePeriodOnly(st: Rest, koToo = true): string | null {
  const zh = st.text.match(ZH_PERIOD_RE);
  if (zh) {
    st.text = st.text.replace(zh[0], ' ');
    return zh[1] ?? '';
  }
  if (!koToo) return null;
  const re = new RegExp(KO_PERIOD_RE.source, 'g');
  for (const k of st.text.matchAll(re)) {
    const rest = st.text.slice(k.index ?? 0);
    if (KO_KEEP_RE.test(rest)) continue;
    st.text = st.text.slice(0, k.index) + ' ' + st.text.slice((k.index ?? 0) + k[0].length);
    return k[1] ?? '';
  }
  return null;
}

/** 已经取走一个时刻以后，标题里还剩“时段词 + 别的事”（R8：“下午3点开会 晚上看电影”“오후 3시 회의 저녁 영화”）：
 *  说明中间只用空格隔开了第二件事，不拆、判没把握。时段词本身是吃饭这件事的不算（同 7a：“점심 먹기”“저녁 식사”）；
 *  时段词后面没有别的字（“12시 점심”）也不算，那就是事由本身 */
export function periodLeft(text: string): boolean {
  for (const re of [new RegExp(ZH_PERIOD_RE.source, 'g'), new RegExp(KO_PERIOD_RE.source, 'g')]) {
    for (const k of text.matchAll(re)) {
      const rest = text.slice(k.index ?? 0);
      if (KO_KEEP_RE.test(rest)) continue;
      if (rest.slice(k[0].length).trim() !== '') return true;
    }
  }
  return false;
}

/** 中文相对时刻（R-374）：数字可以是阿拉伯数字或“两 / 十五 / 二十”这类中文数字 */
const REL_N = '(\\d{1,3}|[一二两三四五六七八九十]{1,3})';
const REL_BODY =
  '(?:' + REL_N + '\\s*个?\\s*(半)?\\s*(?:小时|钟头)(?:\\s*零?\\s*' + REL_N + '\\s*分钟?)?' +
  '|(半)\\s*个?\\s*(?:小时|钟头)' +
  '|' + REL_N + '\\s*分钟' +
  '|([一三])\\s*刻钟)';
/** 分组：1 过、2 小时数、3 半、4 小时后面的分钟、5 单说“半小时”、6 分钟数、7 一 / 三刻钟、8 后。
 *  前面不能紧挨数字、“点”、冒号（“3点10分钟后”不认）；“过 N 分钟”可以不带“后”，别的必须带“后 / 以后 / 之后 / 过后”。
 *  “过”只认白名单（代码审第二轮：黑名单挡不全“熬过 / 睡过 / 看过 / 跳过 / 路过……两小时”）：在开头、标点后，
 *  或紧跟“再 / 等 / 大概 / 大约 / 约 / 差不多”（中间可隔空格）；字后隔空格的（“超 过30分钟”）不认。
 *  不认的“过”不吞进来，后面没有“后”就是时长、限度，不记时刻；“不过10分钟后到”带“后”照认 */
const REL_GUO_OK = '(?<=(?:^|[，。,.!?！？、；;：:（）()]|再|等|大概|大约|约|差不多)\\s*)';
const REL_RE = new RegExp('(?<![\\d点:])(' + REL_GUO_OK + '过\\s*)?' + REL_BODY + '(\\s*(?:以后|之后|过后|后))?', 'g');
/** 最多认多远（分钟） */
export const REL_MAX_MIN = 72 * 60;

/** 取走一句里第一个中文相对时刻，返回从现在起多少分钟；没有、或者超过 72 小时返回 null（不取走） */
export function takeRelative(st: Rest): number | null {
  const n = (w: string | undefined): number => (w === undefined ? 0 : (cnNum(w) ?? Number.NaN));
  for (const m of st.text.matchAll(REL_RE)) {
    if (!m[1] && !m[8]) continue;   // 不带“过 / 后”的是时长（“开会两小时”），不认
    let min: number;
    if (m[2] !== undefined) min = n(m[2]) * 60 + (m[3] ? 30 : 0) + n(m[4]);
    else if (m[5]) min = 30;
    else if (m[6] !== undefined) min = n(m[6]);
    else min = m[7] === '三' ? 45 : 15;
    if (!Number.isFinite(min) || min <= 0 || min > REL_MAX_MIN) return null;
    st.text = st.text.slice(0, m.index) + ' ' + st.text.slice((m.index ?? 0) + m[0].length);
    return min;
  }
  return null;
}
