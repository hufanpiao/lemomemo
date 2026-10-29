const name = ['FN', 'VAULT', 'DB', 'URL'].join('_');
// 违规 F7：变量当名字
export const a = Deno.env.get(name);
// 违规 F7：模板字符串带 ${}
export const b = Deno.env.get(`R2_${'FN'}_ACCESS_KEY_ID`);
// 违规 F7、F3：方括号取 env 不在 Deno 白名单里（F7，代码审查有条件通过 1）；字面量名字 F3 照样认出
export const c = Deno['env'].get('R2_FN_ACCESS_KEY_ID');
