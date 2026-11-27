// 迷你 db.ts（B1 接手清单 S3 复审必改，乙方案）：四个按角色分开的导出；withScan 是改造前收角色参数的旧写法，留着证明导入它就报 F2
export type Tx = { q: number };
const run = (role: 'fn_vault' | 'fn_ai', f: () => Promise<number>) => (role === 'fn_ai' ? f() : f());
export const withVaultUser = (_uid: string, f: () => Promise<number>) => run('fn_vault', f);
export const withVaultScan = (f: () => Promise<number>) => run('fn_vault', f);
export const withAiUser = (_uid: string, f: () => Promise<number>) => run('fn_ai', f);
export const withAiScan = (f: () => Promise<number>) => run('fn_ai', f);
export const withScan = (role: string, f: () => Promise<number>) => run(role === 'fn_ai' ? 'fn_ai' : 'fn_vault', f);
