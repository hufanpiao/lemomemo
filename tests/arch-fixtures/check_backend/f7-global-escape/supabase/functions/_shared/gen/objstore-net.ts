// 对照：登记过的别名 G = globalThis as …，之后只跟 .标识符；违规 F7：把别名整个交出去
interface TimerGlobals { setTimeout(fn: () => void, ms: number): unknown }
const G = globalThis as unknown as TimerGlobals;
export const timer = G.setTimeout(() => {}, 1);
export const leak = G;
