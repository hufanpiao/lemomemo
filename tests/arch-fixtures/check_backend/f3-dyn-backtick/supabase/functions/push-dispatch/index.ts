// 违规 F3：九个函数以外用反引号的动态 import 引 objstore（模板字符串，审查中 2）
export const load = () => import(`../_shared/gen/objstore.ts`);
