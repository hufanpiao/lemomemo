// 违规 F1（TC-B0-35）：函数里读默认的 SUPABASE_DB_URL（postgres 角色，绕开 fn_vault / fn_ai 的会话变量版 RLS）
export const url = Deno.env.get('SUPABASE_DB_URL');
