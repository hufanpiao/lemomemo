// 代码审查第六轮必改 4 → 第七轮必改 3：第六轮按声明文本放行的写法（第 2 行），第七轮改成绑节点位置后也不再放行；其余各行照报
export function ok(row: Record<string, unknown>, flag: string) { return row[flag]; }
export function w1(row: any, flag: string) { return row[flag]; }
const flag = ['constr', 'uctor'].join('');
export const w2 = (row: Record<string, unknown>) => row[flag];
export function w3() { type Record<K, V> = any; return (row: Record<string, unknown>, flag: string) => row[flag]; }
export function w4() { type Record<K, V> = { [k: string]: () => void }; return (row: Record<string, unknown>, flag: string) => row[flag]; }
const e4row: any = () => 0;
export const e4 = e4row[flag];
