// 违规 F7（代码审查第六轮必改 3）：Reflect / Object 按键取属性，键走方括号同一条规则；Reflect 只准直接调用；apply / construct 的函数只准静态
const k = ['constr', 'uctor'].join('');
export const r1 = Reflect.get(() => 0, k);
export const r2 = Reflect.has({}, k);
export const r3 = Object.getOwnPropertyDescriptor(() => 0, k);
export const r4 = Object.getOwnPropertyDescriptors(() => 0);
export const r5 = Reflect;
export const { get: r6 } = Reflect;
export const r7 = Object.getOwnPropertyDescriptor;
const fs: Array<(...a: unknown[]) => unknown> = [() => 0];
export const r8 = Reflect.apply(fs[0], null, []);
export const r9 = Reflect.construct(globalThis.Date, []);
export const r10 = globalThis.Reflect.get({}, k);
export const r11 = Reflect.get(...([{}, 'a'] as const));
