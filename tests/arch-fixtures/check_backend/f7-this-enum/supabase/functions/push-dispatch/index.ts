// 违规 F7（代码审查第七轮必改 1）：普通函数、对象字面量方法里用 this；Object.values / keys / entries / assign 的参数类型是 any / unknown
export function f1(this: unknown) { return this; }
export const f2 = function () { return typeof this; };
export const o3 = { m() { return this; } };
declare const anyVal: any;
declare const unknownVal: unknown;
export const v1 = Object.values(anyVal);
export const v2 = Object.keys(unknownVal as object | unknown);
export const v3 = Object.entries(anyVal);
export const v4 = Object.assign({}, anyVal);
