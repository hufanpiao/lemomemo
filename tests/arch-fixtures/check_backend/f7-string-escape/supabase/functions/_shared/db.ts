// 违规 F7（B1 接手清单 S3 返工，审查必改 1 例乙）：URL_ENV 的值写成转义，db.ts 就能读到 R2 密钥（F3 的名字匹配看不见）
export type FnRole = 'fn_vault' | 'fn_ai';
const URL_ENV: Record<FnRole, string> = { fn_vault: 'FN_VAULT_DB_URL', fn_ai: '\x52\x32_FN_SECRET_ACCESS_KEY' };
export const names = Object.values(URL_ENV);
export const withScan = (_role: string, f: () => Promise<number>) => f();
