// 违规 F7（代码审查第三轮必改 2）：不靠字面量拿到 Deno、process 的写法，每行一种
export const b1 = Reflect.get(globalThis, 'De' + 'no');
export const b10 = Object.getOwnPropertyDescriptor(globalThis, 'De' + 'no');
export const b2 = (0, eval)('1');
export const b3 = new Function('return 1')();
export const b3b = Function('return 1')();
const g = globalThis; export const b4 = g;
export const b5 = globalThis?.setTimeout;
export const b6 = [self, window];
export const b7 = String(globalThis);
export const b8 = 'Deno';
