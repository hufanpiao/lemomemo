// 对照：for 循环下标的 number 键、字面量联合键、字面量键不报
const bytes = [1, 2, 3];
let a = 0; for (let i = 0; i < bytes.length; i++) a += bytes[i] ?? bytes[i * 2 + 1] ?? 0;
export { a };
const rec: Record<string, number> = { x: 1 };
const key: 'x' | 'y' = 'x';
export const b = rec[key];
export const c = rec['x'];
const { ['x' as 'x' | 'y']: d } = rec;
export const e = d;
