// 样例：环（cyc-a ↔ cyc-b），cyc-a 先引 cyc-b、后引农历
import { b } from './cyc-b.ts';
import { toLunar } from './anniv/lunar.ts';
export const a = () => [b, toLunar];
