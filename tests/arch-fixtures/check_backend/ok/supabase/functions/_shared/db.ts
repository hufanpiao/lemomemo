// 禁止 SUPABASE_DB_URL（注释不算）
type FnRole = 'fn_vault' | 'fn_ai';
export function withUser(role: FnRole) { return role === 'fn_vault' ? Deno.env.get('FN_VAULT_DB_URL') : Deno.env.get('FN_AI_DB_URL'); }
