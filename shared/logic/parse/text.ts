// i18n-exempt: 解析词表
// 本机规则（B 路）的文字预处理和公共工具（B3 任务单 BE-2；移植 v3 待办APP/src/scripts/logic/parse-text.js）：
//   全角数字和标点转半角；中文星期先改成数字（防止“周五十点”被读成 50）；中文数字转阿拉伯数字（“两点”“二十五分”“十一月”“三点二十”，
//   以及“八月十五”“三月初三”这种月后面的日子）；韩文固有数词 + 시 转数字（“세 시”“오후세시”→“3시”）；
//   take() / cut() 从剩余文字里取走一段（换成空格）。纯函数，前端和 Edge Functions 共用。
// 和 v3 的差别：固有数词前面紧挨着“오전 / 오후 / 저녁……”也认（语音转写不分写，“내일오후세시에”）；“月”后面的中文数字和“初N”也转。

/** 词表查值：只取自有属性（check_backend F7） */
export const pick = <V>(o: Readonly<Record<string, V>>, k: string): V | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

const CN_DIGIT: Readonly<Record<string, number>> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_WEEKDAY: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const KO_NATIVE: Readonly<Record<string, number>> = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12,
};

/** “十”“十五”“二十”“两”→ 数字；认不出返回 undefined */
export function cnNum(w: string): number | undefined {
  if (/^\d+$/.test(w)) return Number(w);
  if (w === '十') return 10;
  if (w.includes('十')) {
    const [a = '', b = ''] = w.split('十');
    const hi = a ? pick(CN_DIGIT, a) : 1;
    const lo = b ? pick(CN_DIGIT, b) : 0;
    return hi === undefined || lo === undefined ? undefined : hi * 10 + lo;
  }
  return pick(CN_DIGIT, w);
}

/** 全角数字、冒号、全角空格转半角（听写和中文输入法常出全角） */
export const toHalfWidth = (s: string): string =>
  s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\uFF1A/g, ':').replace(/[\u3000 ]/g, ' ');

/** 周X / 星期X / 礼拜X 的 X 先换成 1–7（7 = 周日） */
export const protectWeekdays = (s: string): string =>
  s.replace(/(周|星期|礼拜)([一二三四五六日天])/g, (_m, a: string, b: string) => a + String(pick(CN_WEEKDAY, b)));

/** 没被取走的“周3 / 星期3 / 礼拜7”换回汉字（代码审 M3：protectWeekdays 改过的数字不能漏进标题） */
export const restoreWeekdays = (s: string): string =>
  s.replace(/(周|星期|礼拜)([1-7])/g, (_m, a: string, b: string) => a + weekdayZh(Number(b)));

/** 1–7 换回中文（标题里保留“每周一”时用） */
export const weekdayZh = (n: number): string => '一二三四五六日'.charAt(n - 1);

/** 中文数字转阿拉伯数字：只处理紧跟“点/月/日/号/分”的、“N点”后面的分钟、“月”后面的日子（含“初N”） */
export function digitize(s: string): string {
  const conv = (w: string): string => {
    const n = cnNum(w);
    return n === undefined ? w : String(n);
  };
  let out = s.replace(/[零一二两三四五六七八九十]{1,3}(?=\s*[点月日号分])/g, conv);
  out = out.replace(/点([零一二两三四五六七八九十]{1,3})(?![刻])/g, (_m, w: string) => '点' + conv(w));
  out = out.replace(/月\s*初?([一二三四五六七八九十]{1,3})(?![点月])/g, (_m, w: string) => '月' + conv(w) + '日');
  return out.replace(/月\s*初(\d{1,2})/g, '月$1');
}

/** 韩文固有数词 + 시：“세 시”“열한 시”→“3시”“11시”（不碰“시간”“시작”）；前面是汉字、空格、时段词都认 */
export const koNative = (s: string): string =>
  s.replace(
    /(?<=^|[^가-힣]|오전|오후|저녁|아침|새벽|밤|낮)(열한|열두|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네)\s*시(?![간작])/g,
    (_m, w: string) => String(pick(KO_NATIVE, w)) + '시',
  );

/** 一句话最多处理多少字（超长输入会让几条正则变慢；超了的部分不解析，整句算没把握） */
export const QUICK_MAX = 500;

/** 预处理：截断、合并空白、半角、保护星期、中文数字、韩文固有数词 */
export function prepare(s: string): string {
  const t = String(s).slice(0, QUICK_MAX).replace(/\s+/g, ' ');
  return koNative(digitize(protectWeekdays(toHalfWidth(t))));
}

/** 解析中的剩余文字：识别到的部分换成空格 */
export interface Rest {
  text: string;
}

/** 在剩余文字里找 re，找到就把那一段换成空格，返回匹配结果 */
export function take(st: Rest, re: RegExp): RegExpMatchArray | null {
  const m = st.text.match(re);
  if (m) st.text = st.text.replace(m[0], ' ');
  return m;
}

/** 把已经找到的那段文字从剩余文字里取走 */
export function cut(st: Rest, str: string): void {
  st.text = st.text.replace(str, ' ');
}

/** 标题里还剩日期、时刻、星期词（parse-split 判 leftover、intent 判查找有没有把握共用；代码审 M3：“到周三出差”“和周五3点开会”“开会和 3点去银行”）：说明一句里还有没认完的日子或时刻，判没把握。
 *  “3号楼”“3号线”这类不算（同 date-words 的排除） */
export const LEFTOVER_RE = new RegExp([
  '\\d{1,2}\\s*(?:点|點|시(?![간작])|:\\d{2})',
  '(?<![\\d.第A-Za-z区层栋])\\d{1,2}\\s*[号日](?![楼栋室线院间])',
  '\\d{1,2}\\s*월\\s*\\d{1,2}\\s*일', '\\d{1,2}\\s*일(?![요간])',
  '(?:周|星期|礼拜)[一二三四五六日天]', '[월화수목금토일]요일',
  '今天|明天|后天|大后天|今晚|明早|明晚|오늘|내일|모레|글피',
].join('|'));
