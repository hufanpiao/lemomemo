// 违规 F7（代码审查有条件通过 3）：正则字面量里的 // 和 /* 不是注释，后面的代码照样查
const r1 = /[//]/; export const a = Deno.env.toObject();
const r2 = /[/*]/; export const b = Deno.env.toObject(); // */
export const t = (s: string) => { if (s) /[//]/.test(s); return Deno.env.toObject(); };
export const r = [r1, r2];
