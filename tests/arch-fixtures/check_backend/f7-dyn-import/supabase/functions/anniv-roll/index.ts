// 违规 F7：变量当路径
const p = '../_shared/db.ts';
export const a = () => import(p);
// 对照：字面量（单引号、不带 ${} 的反引号）不报
export const b = () => import('./local.ts');
export const c = () => import(`./local.ts`);
