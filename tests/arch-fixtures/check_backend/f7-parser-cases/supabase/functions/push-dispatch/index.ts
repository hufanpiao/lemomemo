// 违规 F7（第三轮 b5～b7、b13）：) 后面的正则、除号后面的 /* 和反引号都藏不住代码；违规 F2（b12）：带第二个参数的动态 import
if (1) /'/.test(''); export const b5 = { ...process.env };
if (1) /'/.test(''); export const b6 = Deno.env.toObject();
const q = 1 / 2; /* `
*/ export const b7 = Deno.env.toObject(); export const q2 = q;
/* ` */
export const b12 = await import('../_shared/db.ts', {});
export const b13 = await import(
  '../_shared/db' + '.ts');
export const b6b = D\u0065no.env.get('X');
