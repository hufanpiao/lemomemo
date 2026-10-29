// 违规 F7（B1 接手清单 S3）：环境变量名的字面量里写转义，值是 R2_FN_…、FN_VAULT_DB_URL，F1～F3 在源码文本上的名字匹配看不见
export const a = Deno.env.get('\x52\x32_FN_ACCESS_KEY_ID');
export const b = Deno.env.has("FN_VAULT\u005fDB_URL");
export const c = Deno.env.get(`SUPABASE\x5fDB_URL`);
// 对照：不带转义的字面量不报
export const ok = Deno.env.get('PUSH_VAPID_KEY');
