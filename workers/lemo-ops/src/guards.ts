// lemo-ops 校验返回体形状用的三个判断，rules.ts 和拆出去的各规则文件共用这一份。

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
