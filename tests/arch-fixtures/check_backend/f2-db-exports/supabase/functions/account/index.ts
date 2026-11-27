// 违规 F7（复审必改）：import * as 引 db.ts（命名空间对象能用计算属性名取成员）
import * as db from '../_shared/db.ts';
export const x = db.withVaultUser;
