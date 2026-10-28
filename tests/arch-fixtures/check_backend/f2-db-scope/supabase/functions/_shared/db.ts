// 迷你 db.ts：只有它读两个连接串
const URL_ENV = { fn_vault: 'FN_VAULT_DB_URL', fn_ai: 'FN_AI_DB_URL' };
export function withUser(role: 'fn_vault' | 'fn_ai') { return Deno.env.get(URL_ENV[role]); }
