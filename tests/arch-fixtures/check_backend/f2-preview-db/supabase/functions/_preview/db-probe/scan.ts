// 违规 F2（S3 第三轮复审建议）：预览专用函数一律不准用 fn_vault，db-probe 导入 withVaultScan 也报（按导出名判断，固定样例）
import { withVaultScan } from '../../_shared/db.ts';
export const s = withVaultScan;
