// 黄历卡（R-431）一天的内容：农历日、干支年 · 农历月、宜、忌。纯函数，只做纯日期运算（Date.UTC），不碰本地时区、不读“现在”
// • 农历日、农历月一律用我们自己的香港天文台数据（lunar.ts 的 toLunar），和月历格子、标题行同一份
// • 干支年按农历年（正月初一换年）：(农历年 − 4) mod 60，2026 → 丙午
// • 宜忌查 lunar-huangli-data.ts（tools/huangli/build.mjs 从开发依赖 lunar-javascript 生成）：
//   节气月的月支按我们的 TERMS_CN（交节当天算新月，和库的默认口径一致），日干支按天数算（1970-01-01 是辛巳日）
// • 本文件静态引入 lunar.ts 和宜忌表，界面一侧只能按需加载本文件（core/anniv-lib.ts 的 loadHuangliLib；ESLint LUNAR 按文件名 lunar* 拦）
// • 超出农历或节气数据范围（公历 1901-01-20～2100-12-31 以外）返回 null，界面不画卡片
import { parseDate, type DateStr } from '../../core/date.ts';
import { itemAt } from '../../core/item-at.ts';
import { HUANGLI_DAYS, HUANGLI_WORDS } from './lunar-huangli-data.ts';
import { dayNumOf, lunarDayName, lunarMonthName, solarTermsOfYear, toLunar } from './lunar.ts';
import { DI_ZHI, TIAN_GAN } from './lunar-names-data.ts';

export interface Huangli {
  /** 农历日：“初七” */
  readonly day: string;
  /** 农历年的干支：“丙午” */
  readonly yearGz: string;
  /** 农历月名：“十月”“闰二月”“冬月” */
  readonly month: string;
  /** 宜、忌的事项（库写“无”的那一边是空数组；“诸事不宜”“余事勿取”照原文） */
  readonly yi: readonly string[];
  readonly ji: readonly string[];
}

/** 1970-01-01（第 0 天）的日干支序号：辛巳 = 17 */
const EPOCH_JIAZI = 17;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** 干支名：序号 0 甲子 … 59 癸亥 */
export const ganzhiName = (i: number): string => TIAN_GAN.charAt(mod(i, 10)) + DI_ZHI.charAt(mod(i, 12));

/** 日干支序号（0 甲子 … 59 癸亥） */
export function dayJiazi(date: DateStr): number {
  return mod(dayNumOf(date) + EPOCH_JIAZI, 60);
}

/** 节气月的月支序号（0 子 … 11 亥）：最近一个“节”（小寒、立春 … 大雪，TERMS 的偶数序号）定月，交节当天算新月；小寒以前是上一年大雪起的子月。没有节气数据回 null */
export function monthZhi(date: DateStr): number | null {
  const terms = solarTermsOfYear(parseDate(date).y, 'cn');
  if (terms === null) return null;
  let k = -1;
  for (let i = 0; i < 24; i += 2) {
    const t = itemAt(terms, i);
    if (t !== undefined && t <= date) k = i;
  }
  return k < 0 ? 0 : (1 + k / 2) % 12;
}

function words(codes: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < codes.length; i += 2) {
    const w = itemAt(HUANGLI_WORDS, parseInt(codes.slice(i, i + 2), 36));
    if (w !== undefined) out.push(w);
  }
  return out;
}

/** 某天的宜忌（只看月支和日干支）；没有节气数据回 null */
export function yiJiOf(date: DateStr): { readonly yi: readonly string[]; readonly ji: readonly string[] } | null {
  const z = monthZhi(date);
  if (z === null) return null;
  const cell = itemAt(HUANGLI_DAYS, z * 60 + dayJiazi(date));
  if (cell === undefined) return null;
  const [yi = '', ji = ''] = cell.split('|');
  return { yi: words(yi), ji: words(ji) };
}

/** 黄历卡一天的内容；格式不对抛 bad_date（同 toLunar），超出数据范围回 null */
export function huangliOf(date: DateStr): Huangli | null {
  const l = toLunar(date, 'cn');
  if (l === null) return null;
  const yj = yiJiOf(date);
  if (yj === null) return null;
  return {
    day: lunarDayName(l.day),
    yearGz: ganzhiName(l.year - 4),
    month: lunarMonthName(l.month, l.isLeap, 'zh-CN'),
    yi: yj.yi,
    ji: yj.ji,
  };
}
