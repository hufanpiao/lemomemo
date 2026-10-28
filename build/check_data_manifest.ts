// D1 的 CI 入口（2.3、3.5 第 4 点）：supabase db reset 以后连本地库，跑 build/d1/checks.ts
// 用法：deno run --allow-net --allow-env --allow-read build/check_data_manifest.ts
//   连接串取 D1_DB_URL，默认是 supabase start 的本地库；不读 SUPABASE_DB_URL（那是服务器函数的，TC-B0-35 静态检查搜它）
//   'zod'、'postgres' 由根目录 deno.json 的 imports 映射（版本和 package.json 一致，tests/build/deno-config.test.ts 核对）
//   也可以 deno task d1
import postgres from 'postgres';   // deno.json 映射到 npm:postgres@3.4.5
import { runD1, type Query } from './d1/checks.ts';
import { allManifests } from '../shared/manifests/index.ts';
import '../shared/schema/kinds.ts';   // 加载时核对 kinds.ts 的字面量名单和清单一致

const url = Deno.env.get('D1_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  // postgres.js 不知道每条 SQL 的列，结果行的形状由 checks.ts 的调用处写明
  const query: Query = <T extends object>(text: string, params: unknown[] = []) => sql.unsafe(text, params as never[]) as unknown as Promise<T[]>;
  const problems = await runD1(query, allManifests);
  if (problems.length) {
    console.error(`D1 不通过：${problems.length} 处`);
    for (const p of problems) console.error('  ' + p);
    Deno.exit(1);
  }
  console.log('D1 通过：数据库和数据清单、授权白名单一致');
} finally {
  await sql.end();
}
