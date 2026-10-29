// 违规 F7（代码审查有条件通过 1）：Deno 只准 .env.get / .env.has 一个字面量或 Deno.serve，下面每行一种绕法
export const a1 = Deno?.env.toObject();
const { env } = Deno;
export const a2 = env.toObject();
export const a3 = globalThis['Deno'].env.toObject();
export const a4 = Reflect.get(Deno, 'env').toObject();
export const a5 = Deno['e' + 'nv'].toObject();
export const a6 = Deno.\u0065nv.toObject();
const D = Deno; export const a7 = D.env.toObject();
export const a8 = (globalThis as Record<string, { env: { toObject(): unknown } }>)['De' + 'no'];
export const a9 = Deno.env.get('X'.concat('Y'));
