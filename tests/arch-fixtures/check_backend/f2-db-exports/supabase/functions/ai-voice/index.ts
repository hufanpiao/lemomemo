// 违规 F2（复审必改）：改名导入看原名——withVaultScan 改叫 scan，照样按 fn_vault 查（ai-voice 只在 fn_ai 名单里）
import { withVaultScan as scan } from '../_shared/db.ts';
export const x = scan(async () => 1);
