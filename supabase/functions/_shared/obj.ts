// 服务器函数共用的小判断：是不是普通对象（不是 null、不是数组）。
// 11-13 独立评审：原来 gemini.ts、ai/wire.ts、consent.ts、ai-classify/store.ts 各写一份，收成这一份。
// tests/ai/score-core.ts、src/ 里的同名函数跨运行时，不引这里。纯函数，不 import 任何东西。

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
