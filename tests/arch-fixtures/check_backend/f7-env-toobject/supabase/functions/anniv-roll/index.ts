// 违规 F7：把 Deno.env 存进变量再读（下一行的字面量名字另由 F3 报）
const env = Deno.env;
export const k = env.get('R2_FN_ACCESS_KEY_ID');
