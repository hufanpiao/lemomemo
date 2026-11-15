// 黄历卡（R-431）的数据范围：公历 1901-01-20～2100-12-31（中国农历表和节气表都覆盖的日子；lunar-huangli.ts 的 huangliOf 在这以外回 null）
// • 单独一个不带表的小文件（R-431 独立评审第 7 条）：日历页不用先下农历、黄历块，就知道这一天有没有黄历卡，加载前先把卡片位置占好、标题行不写农历
// • tests/shared/anniv/lunar-huangli.test.ts 钉住它和 huangliOf 的边界一致；tools/huangli/build.mjs 逐日对拍也用这两个数
import type { DateStr } from '../../core/date.ts';

export const HUANGLI_FIRST = '1901-01-20';
export const HUANGLI_LAST = '2100-12-31';

/** 这一天在黄历数据范围内（YYYY-MM-DD 按字符串比就是按日期比） */
export const inHuangliRange = (date: DateStr): boolean => date >= HUANGLI_FIRST && date <= HUANGLI_LAST;
