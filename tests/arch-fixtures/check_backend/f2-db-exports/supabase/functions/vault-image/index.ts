// 违规 F2（复审必改）：经 _shared/vault-helper.ts 转手用到 withVaultUser（vault-image 只在 fn_ai 名单里）
import { helper } from '../_shared/vault-helper.ts';
// 对照：fn_ai 名单里的函数导入 withAiUser、只当类型导入 Tx 不报
import { withAiUser, type Tx } from '../_shared/db.ts';
export const x = [helper, withAiUser] as const;
export type T = Tx;
