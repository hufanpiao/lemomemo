// 对照：只引类型（import type、export type … from），编译后不留
import type { LunarDate } from './anniv/lunar.ts';
export type { LunarDate as LD } from './anniv/lunar.ts';
export const empty = (x: LunarDate | null) => x;
