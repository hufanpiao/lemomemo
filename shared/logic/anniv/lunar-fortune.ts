// 今日运势卡（负责人 11-21 定稿“八字 B 版”）的算法：确定性、不联网，纯日期运算（Date.UTC），不碰本地时区、不读“现在”。
// 参考实现是方案页 柠檬记APP-本机资料/设计方案/2026-11-21_今日运势/方案-八字-B.html 里的 bazi()、fortune()，这里逐步照写：
// 1. 排八字：年柱按立春换年（出生日早于那年立春算上一年，序号 (年 − 4) mod 60）；月柱按“节”换月（交节当天算新月，lunar-ganzhi.ts 的 monthZhi），
//    月干用五虎遁由年干推；日柱按天数推（dayJiazi）；时柱填了才有，两小时一段，时干用五鼠遁由日干推；23 点以后算第二天（日柱 + 1）
// 2. 日主 = 日柱天干；强弱（简化）：数各柱里帮日主的（同类、生它的；日干本身不算）有几个，超过一半算强
// 3. 当天类型：当天日干对日主算十类之一（序号 = 关系 × 2 + 阴阳不同）
// 4. 星级：基准 3.5 + 这一类的偏移；强的人遇消耗型的日子加、帮扶型减，弱的人反过来；日支六合 +0.75、相冲 −0.75，时支 ±0.25；四舍五入，限 2～5。
//    弱的人遇消耗型里的享受日、表达日（序号 2、3，“你生的”那两类）不加不减、遇机会日、收获日（序号 4、5）才减 0.5：
//    来源是参考实现 fortune() 那一行 `G.type==='out'&&g<4?0:-.5`（方案-八字-B.html 第 379 行），照写
// 5. 分项（工作、感情、财运、健康）= 星级 ± 这一类的固定偏移，限 2～5；短句按哈希挑
// 6. 幸运色和数字：先定这个人的底（强取“你生的”五行，弱取“生你的”），再按当天日支往后挪（底 + 日支序号，对 5 取余），每天换一个五行、五行都会轮到；
//    再按“八字 + 日期”的哈希在那个五行的两种颜色、两个数字里各挑一个（负责人 11-22：原来一个人永远只有两种颜色、两个数字，选“每天跟着当天变”）
// 7. 第一行文案“不连着重复”（方案页“挑文案不重复”）：同一个人同一类日子每 10 天来一次（日干 10 天一轮），第 k 次按“八字 + 类型 + 第几轮”洗牌轮着取，
//    轮与轮交界处和上一轮最后一句相同时换一下；只有两句的一类就是两句轮流。哈希仍按参考实现的顺序先取一次（不用），分项和参考实现逐日一致
// 已知口径（韩国常见算法用 KST、时辰挪半小时，本版不做）：节气日期按中国时间（lunar.ts 的 'cn' 节气表），时辰按整点切（23–1 点子时、1–3 点丑时 …），不加半小时偏移。
// 交节当天（每月一天，约 3%）只按“交节当天算新月”的口径，不分交节前后（节气表只精确到日）。数据范围外（出生年没有节气表）回 null
// 本文件静态引 lunar.ts 的节气表，界面一侧只能按需加载（core/anniv-lib.ts 的 FORTUNE_LIB；ESLint LUNAR 按文件名 lunar* 拦）
import { fmtDateStr, parseDate, type DateStr } from '../../core/date.ts';
// FNV-1a 的唯一实现在 shared/core/fnv.ts；经 project-color.ts 转出来引（理由见那里：不在首屏多拆一块）
import { fnv1a as fnv } from '../project-color.ts';
import { itemAt } from '../../core/item-at.ts';
import { dayJiazi, mod, monthZhi } from './lunar-ganzhi.ts';
import { dayNumOf, solarTermsOfYear } from './lunar.ts';
import { DI_ZHI, TIAN_GAN } from './lunar-names-data.ts';
import { FORTUNE_CATS, FORTUNE_TIPS } from './lunar-fortune-data.ts';

export { FORTUNE_CATS, FORTUNE_COLORS, FORTUNE_DAY_NAMES, FORTUNE_ME, FORTUNE_TIPS } from './lunar-fortune-data.ts';

/** 生日：时段 h 是两小时一段的起点（23、1、3 … 21），不知道是 null */
export interface Birth {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number | null;
}

/** 一柱：[天干序号 0 甲 … 9 癸, 地支序号 0 子 … 11 亥] */
export type Pillar = readonly [stem: number, branch: number];

export interface Fortune {
  /** 年、月、日柱，填了时段的再加时柱 */
  readonly pillars: readonly Pillar[];
  /** 日主（日柱天干），对应 FORTUNE_ME 的序号 */
  readonly me: number;
  readonly strong: boolean;
  /** 当天类型（十类之一），对应 FORTUNE_DAY_NAMES、FORTUNE_TIPS 的序号 */
  readonly day: number;
  /** 综合星级 2～5 */
  readonly stars: number;
  /** 第一行文案：FORTUNE_TIPS[day] 里的第几句 */
  readonly tip: number;
  /** 幸运色：令牌 --luck-N 的 N（五行 × 2 + 第几个），名字是 FORTUNE_COLORS[N >> 1][N & 1] */
  readonly color: number;
  readonly num: number;
  /** 四个分项：星级和 FORTUNE_CATS[i].lines 里的第几句 */
  readonly cats: readonly { readonly stars: number; readonly line: number }[];
}

/** 地支的五行（0 木 1 火 2 土 3 金 4 水） */
const BRANCH_EL = [4, 2, 0, 0, 2, 1, 1, 2, 3, 3, 2, 4] as const;
/** 五行对应的两个幸运数字 */
const EL_NUM = [[3, 8], [2, 7], [5, 10], [4, 9], [1, 6]] as const;

type DayType = 'help' | 'out' | 'press';
/** 十类日子的星级偏移、四个分项的偏移、类型（帮扶 / 消耗 / 压力）；序号同 FORTUNE_DAY_NAMES */
const GODS: readonly { readonly base: number; readonly d: readonly [number, number, number, number]; readonly type: DayType }[] = [
  { base: 0, d: [0, 0, -1, 0], type: 'help' },
  { base: -0.25, d: [0, -1, -1, 0], type: 'help' },
  { base: 0.25, d: [0, 1, 0, 1], type: 'out' },
  { base: 0, d: [-1, 0, 0, 0], type: 'out' },
  { base: 0, d: [0, 1, 1, 0], type: 'out' },
  { base: 0.25, d: [0, 0, 1, 0], type: 'out' },
  { base: -0.25, d: [1, 0, 0, -1], type: 'press' },
  { base: 0, d: [1, 0, 0, 0], type: 'press' },
  { base: 0, d: [0, -1, 0, 0], type: 'help' },
  { base: 0.25, d: [0, 0, 0, 1], type: 'help' },
];

/** 天干的五行 */
const stemEl = (s: number): number => Math.floor(s / 2);
const clampStars = (n: number): number => Math.max(2, Math.min(5, n));

/** 十类日子：other 天干对日主 me */
export const dayTypeOf = (me: number, other: number): number => mod(stemEl(other) - stemEl(me), 5) * 2 + (me % 2 !== other % 2 ? 1 : 0);

/** mulberry32：[0, 1) 的确定性序列（同参考实现） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 排八字；出生年没有节气数据回 null */
export function baziOf(b: Birth): readonly Pillar[] | null {
  // 出生那一年的节气表只取一次：立春定年柱，“节”定月柱
  const terms = solarTermsOfYear(b.y, 'cn');
  const lichun = terms === null ? undefined : itemAt(terms, 2);
  if (terms === null || lichun === undefined) return null;
  const date = fmtDateStr(b.y, b.m, b.d);
  const mz = monthZhi(date, terms);
  const yi = mod((date >= lichun ? b.y : b.y - 1) - 4, 60);
  const ys = yi % 10;
  const ms = mod((ys % 5) * 2 + 2 + mod(mz - 2, 12), 10);
  let di = dayJiazi(date);
  if (b.h !== null && b.h >= 23) di = mod(di + 1, 60);
  const out: Pillar[] = [[ys, yi % 12], [ms, mz], [di % 10, di % 12]];
  if (b.h !== null) {
    const hz = Math.floor((b.h + 1) / 2) % 12;
    out.push([mod(((di % 10) % 5) * 2 + hz, 10), hz]);
  }
  return out;
}

/** 帮日主的数（同类、生它的）和总数；日干本身不算 */
function helpCount(p: readonly Pillar[], meEl: number): { readonly help: number; readonly total: number } {
  let help = 0;
  let total = 0;
  const helps = (e: number): boolean => e === meEl || mod(meEl - e, 5) === 1;
  p.forEach(([s, z], i) => {
    if (i !== 2) {
      total++;
      if (helps(stemEl(s))) help++;
    }
    total++;
    if (helps(itemAt(BRANCH_EL, z) ?? -1)) help++;
  });
  return { help, total };
}

/** 0..n-1 按种子洗牌（Fisher–Yates，rng 同上） */
function shuffled(n: number, seed: number): number[] {
  const r = rng(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const x = a.at(i) ?? i;
    a.splice(i, 1, a.at(j) ?? j);
    a.splice(j, 1, x);
  }
  return a;
}

/** 第一行文案取第几句：k 是这一类日子第几次出现（日干 10 天一轮），见文件头第 7 条 */
export function tipIndex(key: string, day: number, k: number, n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return mod(k + fnv(`v1|${key}|${day}`), 2);
  const round = Math.floor(k / n);
  const seed = (r: number): number => fnv(`v1|${key}|${day}|${r}`);
  const order = shuffled(n, seed(round));
  const prevLast = shuffled(n, seed(round - 1)).at(n - 1);
  if (order.at(0) === prevLast) order.splice(0, 2, order.at(1) ?? 1, order.at(0) ?? 0);
  return order.at(mod(k, n)) ?? 0;
}

/** 某人某天的运势；出生年没有节气数据回 null */
export function fortuneOf(b: Birth, date: DateStr): Fortune | null {
  const p = baziOf(b);
  const dayP = p?.at(2);
  if (!p || !dayP) return null;
  const me = dayP[0];
  const meEl = stemEl(me);
  const key = p.map(([s, z]) => TIAN_GAN.charAt(s) + DI_ZHI.charAt(z)).join('');
  const { help, total } = helpCount(p, meEl);
  const strong = help * 2 > total;
  const di = dayJiazi(date);
  const ds = di % 10;
  const dz = di % 12;
  const day = dayTypeOf(me, ds);
  const luckEl = mod((strong ? meEl + 1 : meEl - 1) + dz, 5);
  // day 0～9、luckEl 0～4，这几张表一定取得到；TS 要收窄，并进上面“没有数据回 null”同一种出口，不另造默认值
  const g = itemAt(GODS, day);
  const nums = itemAt(EL_NUM, luckEl);
  const tips = itemAt(FORTUNE_TIPS, day);
  if (!g || !nums || !tips) return null;
  let sc = 3.5 + g.base;
  if (strong) sc += g.type === 'help' ? -0.5 : 0.75;
  else sc += g.type === 'help' ? 0.75 : g.type === 'out' && day < 4 ? 0 : -0.5;
  const rel = (z: number, w: number): void => {
    if ((dz + z) % 12 === 1) sc += w;
    if (Math.abs(dz - z) === 6) sc -= w;
  };
  rel(dayP[1], 0.75);
  const hourP = p.at(3);
  if (hourP) rel(hourP[1], 0.25);
  const stars = clampStars(Math.round(sc));
  const { y, m, d } = parseDate(date);
  const r = rng(fnv(`v1|${key}|${y}-${m}-${d}`));
  r(); // 参考实现这一下挑文案；文案改成洗牌（tipIndex），这一下照取，后面的颜色、数字、分项和参考实现一致
  // 每个五行两种颜色、两个数字（FORTUNE_COLORS、EL_NUM）：参考实现 Math.floor(r() * 2) 就是 r() < 0.5 取第一个
  const color = luckEl * 2 + (r() < 0.5 ? 0 : 1);
  const num = r() < 0.5 ? nums[0] : nums[1];
  const cats = FORTUNE_CATS.map((c, i) => ({ stars: clampStars(stars + (itemAt(g.d, i) ?? 0)), line: Math.floor(r() * c.lines.length) }));
  const tip = tipIndex(key, day, Math.floor(dayNumOf(date) / 10), tips.length);
  return { pillars: p, me, strong, day, stars, tip, color, num, cats };
}
