// 对照：数组下标的数字运算、字面量下标的调用、类的 constructor 声明、名字里只是带这些字样的不报
// （string 变量当键归 f7-key-type 查，这里不放；handlers[String(i)] 这类按选项乙本就该报）
const bytes = [1, 2, 3]; const i = 0;
export const b = bytes[i + 1] ?? bytes[(i >> 1) * 2];
const handlers: Record<string, () => number> = { a: () => 1 };
export const h = handlers['a']();
export class Box { readonly n: number; constructor(n: number) { this.n = n; } }
export const words = ['constructors', 'Workers', 'data:', 'blob'];
