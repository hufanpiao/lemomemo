// 违规 F2：名单外的函数用反引号的动态 import 引 _shared/db.ts
export const load = () => import(`../_shared/db.ts`);
