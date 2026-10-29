// 违规 F7（复审必改）：export * 把 db.ts 整个转手出去
export * from '../_shared/db.ts';
// 对照：vault 在 fn_vault 名单里，具名导入 withVaultUser、withVaultScan 不报
import { withVaultUser, withVaultScan } from '../_shared/db.ts';
export const y = [withVaultUser, withVaultScan];
