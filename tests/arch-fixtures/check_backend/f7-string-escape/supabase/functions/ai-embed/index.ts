import { withAiScan as withScan } from '../_shared/db.ts';
// 违规 F7（审查必改 1 例甲）：角色名写成转义（db.ts 收角色参数时，ai-embed 这样就能用上 fn_vault；现在 db.ts 已按角色分开导出，转义照样报）
export const x = withScan('fn\x5fvault', async () => 1);
// 对照：同一个函数用 fn_ai 不报
export const y = withScan('fn_ai', async () => 2);
