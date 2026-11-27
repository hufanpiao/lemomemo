// 违规 F2：fn_ai 名单里的函数经大小写不同的路径 ../_Shared/Db.ts 导入 withVaultUser，照样按 fn_vault 查
import { withVaultUser } from '../_Shared/Db.ts';
// 对照：同样写法导入 withAiUser 不报
import { withAiUser } from '../_shared/Db.ts';
export const x = [withVaultUser, withAiUser];
