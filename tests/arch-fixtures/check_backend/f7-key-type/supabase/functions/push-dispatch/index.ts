// 违规 F7（第五轮，剩余风险①选项乙）：键的类型是 string
const k: string = ['constr', 'uctor'].join('');
const obj = {} as Record<string, () => unknown>;
export const d1 = obj[k];
const j = 'De' + 'no';
export const d1b = (globalThis as Record<string, { env: unknown }>)[j];
const o = { f: () => 0 };
const ck = 'construc' + String.fromCharCode(116);
const { [ck]: C } = o as Record<string, unknown>;
export const d7 = C;
