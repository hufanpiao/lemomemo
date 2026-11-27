import { withScan } from '../_shared/db.ts';
// 违规 F2（复审必改，r5：字符串拼接拼出 fn_vault）：只准导入四个按角色分开的导出，收角色参数的 withScan 一律不准导入
export const x = withScan('fn_' + 'vault', async () => 1);
