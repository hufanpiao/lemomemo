// 违规 F7（代码审查第六轮必改 1）：类型断言把拼出来的字符串伪装成字面量类型或数字；参数类型是字面量也追不到字面量
const k = ['constr', 'uctor'].join('') as 'length';
export const a1 = (() => 0)[k];
const n: number = ['constr', 'uctor'].join('') as unknown as number;
export const a2 = ((() => 0) as unknown as Record<number, unknown>)[n];
let m = 0; m = ['x'].join('') as unknown as number;
export const a3 = [1, 2][m];
const s = <'name'>['De', 'no'].join('');
export const a4 = (() => 0)[s];
export const a5 = (key: 'length') => (() => 0)[key];
