// 样例：同目录写法静态引入农历（src 引它 = 隔一层）
import { toLunar } from './lunar.ts';
export const nextDate = (d: string) => toLunar(d);
