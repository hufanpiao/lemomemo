// 对照：数字字面量、const 数字常量、for 循环下标、.length 的算术（含位运算、取余）不报
const arr = [1, 2, 3];
const MID = 1;
export const b1 = arr[0] ?? arr[MID];
let sum = 0;
for (let i = 0; i < arr.length; i++) sum += (arr[i] ?? 0) + (arr[(i + 1) % arr.length] ?? 0);
export const b2 = arr[arr.length - 1] ?? arr[(arr.length >> 1) | 0];
export { sum };
