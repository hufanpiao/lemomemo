// 违规 F2：fn_ai 那一组的函数用 fn_vault 角色（只有 vault、vault-file、account 能用 fn_vault）
import { withAiUser as withUser } from '../_shared/db.ts';
export const x = withUser('fn_vault');
