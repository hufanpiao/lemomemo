// 违规 F2（B1 接手清单 S3）：仓库根 deno.json 的别名 rootdb 指到 _shared/db.ts
import { withAiUser as db } from 'rootdb';
export const x = db;
