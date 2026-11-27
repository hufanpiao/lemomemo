// 违规 F7（复审必改）：动态 import db.ts（拿到整个模块对象）
export const m = () => import('../_shared/db.ts');
// 违规 F2：db.ts 没有默认导出，默认导入一律报
import db from '../_shared/db.ts';
export const d = db;
