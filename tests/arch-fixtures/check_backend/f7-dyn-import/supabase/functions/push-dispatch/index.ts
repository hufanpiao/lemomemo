// 违规 F7（S3）：动态 import 拼路径
export const a = () => import('../_shared/' + 'db.ts');
// 违规 F7：带 ${} 的模板字符串
const name = 'objstore';
export const b = () => import(`../_shared/gen/${name}.ts`);
