// 违规 F2（S3）：经 import map 别名 @db 引 _shared/db.ts
import { withAiUser as db } from '@db';
export const x = db;
