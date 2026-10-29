// 违规 F2（S3）：package.json 的 "imports" 子路径别名 #db
import { withAiUser as db } from '#db';
// 违规 F3：条件写法的某一支是 aws4fetch
import '#sign';
export const x = db;
