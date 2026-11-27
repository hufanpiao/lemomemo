// 对照：类型具体的对象、对象字面量、两支都是对象字面量的条件展开不报
const rec: Record<string, number> = { a: 1 };
const host = Math.random() > 0.5 ? 'h' : '';
export const v1 = Object.values(rec);
export const v2 = Object.assign({}, rec, { b: 2 });
export const s1 = { ...rec, ...(host ? { servername: host } : {}) };
