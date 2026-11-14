// 对照：静态引入 lazy.ts，但 lazy.ts 只 import() 农历
import { lazyLunar } from './lazy.ts';
export const viaLazy = lazyLunar;
