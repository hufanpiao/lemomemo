// 违规样例（LUNAR）：静态引入农历换算和数据
import { toLunar } from '../../../../shared/logic/anniv/lunar.ts';
import { LUNAR_CN } from '../../../../shared/logic/anniv/lunar-data';
export { lunarText } from '../../../../shared/logic/anniv/lunar.ts';
import '../../../../shared/logic/anniv/lunar-names-data.ts';
const m = require('../../../../shared/logic/anniv/lunar.ts');
export const x = [toLunar, LUNAR_CN, m];
