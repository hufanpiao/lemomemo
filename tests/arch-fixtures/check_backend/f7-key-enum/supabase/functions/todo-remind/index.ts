// 对照：不用枚举，用 const 字面量常量当键不报
const C = 'c';
const rec: Record<'c' | 'd', number> = { c: 1, d: 2 };
export const a = rec[C];
const ZERO = 0;
export const b = [1, 2][ZERO];
