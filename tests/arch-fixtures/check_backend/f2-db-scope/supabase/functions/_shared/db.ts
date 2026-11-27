// 迷你 db.ts：只有它读两个连接串
type FnRole = 'fn_vault' | 'fn_ai';
export function withUser(role: FnRole) { return role === 'fn_vault' ? Deno.env.get('FN_VAULT_DB_URL') : Deno.env.get('FN_AI_DB_URL'); }
