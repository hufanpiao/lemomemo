// 违规 F7（代码审查第七轮必改 2）：number 键只放行数字字面量、for 循环下标、.length 的算术；其余一律报
const arr = [1, 2, 3];
const k1: number = JSON.parse('1');
export const a1 = arr[k1];
export function a2(xs: number[], k: number) { return xs[k]; }
function toNum(x: string): number { return Number(x); }
export const a3 = arr[toNum('1')];
let k4 = 0; k4 += 1;
export const a4 = arr[k4];
export const a5 = arr[Math.floor(arr.length / 2)];
