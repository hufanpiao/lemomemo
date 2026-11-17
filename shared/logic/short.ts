// 月历简称（架构 5.12 第 2 点、R-104、R-446、第三轮架构 L3；TC-B2-10、11）
// 月历标签和周视图色块写的是这件事的 short；AI 没生成、用户也没填时，显示时取 itemShort(title)。
// 规则：去掉标点（R-446 起中间的也去，夹在数字中间的留）、跳过所有空白，取前 SHORT_GRAPHEMES 个字形簇（Intl.Segmenter grapheme：韩文音节、emoji、带组合符号的字、
// ZWJ 连起来的家庭 emoji 都算一个）。英文也一样取前 N 个字形簇（“SignPlex review” → “Sign”），R-104 定的，不另设例外。
// R-446（11-17 负责人“日历里面日程不是显示4个字嘛？怎么还是两个字”）：上限由 2 改成 4；标题开头是阿拉伯数字时先缩写
// （整万写“N万”、整千写“N千”，标题含谚文写 만、천；其余数字照留），再去掉紧跟的一个量词，然后取前 4 个
// （“5000个瓶子出货”→“5千瓶子”，“3个会”→“3会”）。数字后面紧跟年月日、时刻、小数点这类的不动（“2000年计划”→“2000”）。
// 纯函数：不碰 DOM、不读设置，前端和 Edge Functions 共用。
import { COUNTERS, HANGUL, NOT_COUNT_NEXT, NOUN_SUFFIX, NUM_UNITS } from './short-data.ts';

/** 简称最多几个字形簇（月格色块按 4 字画；AI 输出校验 shared/schema/ai.ts、提示词 record.v7 同一个数） */
export const SHORT_GRAPHEMES = 4;

/** AI 存的简称不到这么多个字形簇时，按标题取的更长就改用按标题取的（R-446：老数据里 AI 存的都是 2 字） */
const AI_SHORT_MIN = 3;

// 字形簇切分和语言无关，传 undefined 用默认；建一次反复用
let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * 标点（\p{P} 含中文、韩文的全角标点；emoji 属于 \p{S}，不去掉）：R-446 放宽到 4 字后，中间的标点也会占位（“【重要】交报告”→“重要】交”），
 * 所以一律去掉；只留夹在两个数字中间的（“1,000”“1.5”“10:00”），免得数字粘成一串
 */
const PUNCT = /(?<!\d)\p{P}|\p{P}(?!\d)/gu;
const ANY_SPACE = /\s+/gu;
/** 开头的整数：1234 或带千分位的 1,234 */
const LEADING_INT = /^(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)/u;
// 词表（量词、日期时刻字、万千写法）在 short-data.ts（架构 A20：源码字符串里不放汉字谚文）

/** 整万、整千缩写（R-446）；ko 为 true 用韩文的万、千 */
function abbrInt(n: number, ko: boolean): string {
  const [wan, qian] = ko ? NUM_UNITS.ko : NUM_UNITS.zh;
  if (n >= 10000 && n % 10000 === 0) return `${n / 10000}${wan}`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}${qian}`;
  return String(n);
}

/**
 * 去掉开头一个量词（kg 不分大小写）；没有量词原样返回。
 * 量词后面紧跟“子”的是名词本身（“3000瓶子”的瓶子、箱子、盒子、袋子、本子），不去。
 */
function dropCounter(rest: string): string {
  if (/^kg/iu.test(rest)) return rest.slice(2);
  const c = COUNTERS.find((w) => rest.startsWith(w));
  if (c === undefined || rest.startsWith(NOUN_SUFFIX, c.length)) return rest;
  return rest.slice(c.length);
}

/**
 * 开头是阿拉伯数字的标题先缩写数字、去掉紧跟的一个量词（R-446）；不是数字开头、或数字后面是日期时刻这类的原样返回。
 * body 是已经去掉开头标点和空白的文字；ko 看整条标题有没有谚文。
 */
export function abbrLeadingNumber(body: string, ko: boolean): string {
  const head = LEADING_INT.exec(body)?.at(0);
  if (head === undefined) return body;
  const rest = body.slice(head.length);
  if (NOT_COUNT_NEXT.test(rest)) return body;
  const n = Number(head.replace(/,/gu, ''));
  if (!Number.isSafeInteger(n)) return body;
  return abbrInt(n, ko) + dropCounter(rest);
}

/** 按 R-104 的规则取前 n 个字形簇（R-446 去掉标点、先处理开头的数字）；空标题、只有标点和空白时返回空串 */
function firstGraphemes(text: string, n: number): string {
  const body = text.normalize('NFC').replace(ANY_SPACE, '').replace(PUNCT, '');
  return graphemes(abbrLeadingNumber(body, HANGUL.test(body))).slice(0, n).join('');
}

/** 事项标题的简称（AI 没生成 short 时显示用） */
export function itemShort(title: string): string {
  return firstGraphemes(title, SHORT_GRAPHEMES);
}

/** 字符串有几个字形簇（AI 输出 schema 校验 short 不超过 SHORT_GRAPHEMES 个字形簇） */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/**
 * 按字截断（代码审 D2）：一个字形簇一个字形簇地取，不把 emoji、带组合符号的字截成半个；
 * 总长按 UTF-16 单元算、不超过 maxUnits（和 shared/schema/rows.ts 里 z.string().max() 同一口径，截完的标题入队不会被拒）
 */
export function cutGraphemes(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let out = '';
  for (const g of graphemes(text)) {
    if (out.length + g.length > maxUnits) break;
    out += g;
  }
  return out;
}

/**
 * 月历、周视图实际显示的简称（R-446）：
 * • 用户手改的（short_by = 'user'）照原样；
 * • 没存 short 的按标题取；
 * • AI 存的（或来源不明的）不到 3 个字形簇、而按标题取的更长时，改用按标题取的（老数据里 AI 存的都是 2 字）；其余照用。
 */
export function displayShort(item: {
  readonly title: string;
  readonly short: string | null;
  readonly short_by: 'ai' | 'user' | null;
}): string {
  const s = item.short?.trim() ?? '';
  if (s === '') return itemShort(item.title);
  if (item.short_by === 'user') return s;
  const n = graphemeCount(s);
  if (n >= AI_SHORT_MIN) return s;
  const t = itemShort(item.title);
  return graphemeCount(t) > n ? t : s;
}

/**
 * 改标题时简称跟不跟着清（第三轮架构 L3）：short_by = 'ai' 时，同一个 patch 里把 short、short_by 清空，
 * 显示回到按新标题取的 itemShort；用户手改的（'user'）和本来就没有的（null）不动，返回空对象。
 * 只在标题真的变了时调用；返回值直接并进 patch。
 */
export function shortPatchOnTitleChange(prev: {
  readonly short_by: 'ai' | 'user' | null;
}): { short: null; short_by: null } | Record<string, never> {
  return prev.short_by === 'ai' ? { short: null, short_by: null } : {};
}
