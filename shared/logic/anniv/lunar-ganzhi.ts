// 干支的小函数（日干支、节气月的月支）：今日运势卡（lunar-fortune.ts）用；年干支只在 lunar-fortune.ts 的 baziOf 算（按立春换年）。
// • 原来在黄历卡的 lunar-huangli.ts 里，11-21 挪出来；11-22 黄历卡整块删掉，这里留给运势（黄历用的干支名 ganzhiName 一起删了）
// • 纯函数，只做纯日期运算（Date.UTC），不碰本地时区、不读“现在”；静态引 lunar.ts（节气表），界面一侧只能按需加载（ESLint LUNAR 按文件名 lunar* 拦）
import type { DateStr } from '../../core/date.ts';
import { itemAt } from '../../core/item-at.ts';
import { dayNumOf } from './lunar.ts';

/** 1970-01-01（第 0 天）的日干支序号：辛巳 = 17 */
const EPOCH_JIAZI = 17;

/** 非负取余 */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** 日干支序号（0 甲子 … 59 癸亥） */
export function dayJiazi(date: DateStr): number {
  return mod(dayNumOf(date) + EPOCH_JIAZI, 60);
}

/** 节气月的月支序号（0 子 … 11 亥）：最近一个“节”（小寒、立春 … 大雪，TERMS 的偶数序号）定月，交节当天算新月；小寒以前是上一年大雪起的子月。
 *  terms 是 date 那一年的 24 节气（lunar.ts 的 solarTermsOfYear，调用方取一次、和年柱共用） */
export function monthZhi(date: DateStr, terms: readonly DateStr[]): number {
  let k = -1;
  for (let i = 0; i < 24; i += 2) {
    const t = itemAt(terms, i);
    if (t !== undefined && t <= date) k = i;
  }
  return k < 0 ? 0 : (1 + k / 2) % 12;
}
