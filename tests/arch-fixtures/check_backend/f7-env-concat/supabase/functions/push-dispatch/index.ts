// 违规 F7（S3）：拼接环境变量名，R2_ 的名字匹配看不见
export const k = Deno.env.get('R2_' + 'FN_SECRET_ACCESS_KEY');
// 对照：字面量名字不报
export const p = Deno.env.get('PUSH_VAPID_KEY');
