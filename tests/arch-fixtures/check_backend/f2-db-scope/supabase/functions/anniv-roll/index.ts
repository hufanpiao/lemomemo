// 违规 F2：名单外的函数经 _shared/helper.ts 间接引到 db.ts
import { withUser } from '../_shared/helper.ts';
export const x = withUser;
