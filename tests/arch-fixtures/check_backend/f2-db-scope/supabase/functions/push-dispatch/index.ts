// 违规 F2：名单外的函数直接 import _shared/db.ts
import { withUser } from '../_shared/db.ts';
export const x = withUser;
