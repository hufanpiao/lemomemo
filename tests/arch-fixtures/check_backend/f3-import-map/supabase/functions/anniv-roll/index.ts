// 违规 F2（S3）：经 import map 别名 @db 引 _shared/db.ts
import { db } from '@db';
export const x = db;
