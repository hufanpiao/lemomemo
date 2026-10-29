// 对照：vault 用 fn_vault，在名单里
import { withVaultUser as withUser } from '../_shared/db.ts';
export const x = withUser('fn_vault');
