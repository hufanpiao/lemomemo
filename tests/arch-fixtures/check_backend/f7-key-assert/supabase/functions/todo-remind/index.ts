// 对照：值本身是字面量的常量、两支都是字面量的条件表达式、for…of 字面量数组、断言包着的字面量、for 循环下标和 .length 的算术都不报
const k = 'length';
export const b1 = [1][k];
const flag = Math.random() > 0.5;
const k2 = flag ? 'a' : 'b';
const rec: Record<'a' | 'b', number> = { a: 1, b: 2 };
export const b2 = rec[k2];
for (const key of ['a', 'b'] as const) rec[key] += 1;
export const b3 = rec['a' as 'a' | 'b'];
const bytes = [1, 2, 3];
let b4 = bytes[bytes.length - 1] ?? 0;
for (let i = 0; i < 2; i += 1) b4 += bytes[i] ?? 0;
