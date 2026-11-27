// 对照：字面量键的 Reflect / Object 调用、静态函数的 apply、Object.keys 这类、类型位置的 Reflect 都不报
const o = { a: 1 };
export const c1 = Reflect.get(o, 'a');
export const c2 = Object.getOwnPropertyDescriptor(o, 'a');
function add(x: number, y: number) { return x + y; }
export const c3 = Reflect.apply(add, null, [1, 2]);
export const c4 = Object.keys(o);
const key = 'a';
export const c5 = Reflect.has(o, key);
export type T = typeof Reflect;
