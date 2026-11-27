// 对照：名单里的 ai-embed 经 package.json 的 #db、仓库根 deno.json 的 rootdb 引 db.ts 不报
import { withAiUser as db } from '#db';
import { withAiScan as d2 } from 'rootdb';
export const x = [db, d2];
