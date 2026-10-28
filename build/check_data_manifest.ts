// D1 的 CI 入口（2.3、3.5 第 4 点）：supabase db reset 以后连本地库，跑 build/d1/checks.ts；再核对 /files 的规则表和清单（build/d1/files-rules.ts，0.32）
// 用法：deno run --allow-net --allow-env --allow-read build/check_data_manifest.ts
//   连接串取 D1_DB_URL，默认是 supabase start 的本地库；不读 SUPABASE_DB_URL（那是服务器函数的，TC-B0-35 静态检查搜它）
//   'zod'、'postgres' 由根目录 deno.json 的 imports 映射（版本和 package.json 一致，tests/build/deno-config.test.ts 核对）
//   也可以 deno task d1
import postgres from 'postgres';   // deno.json 映射到 npm:postgres@3.4.5
import { runD1, type Query } from './d1/checks.ts';
import { checkFilesRules, FILES_FUNCTION_DIR, FILES_RULES_PATH, type FilesRulesInput } from './d1/files-rules.ts';
import { allManifests } from '../shared/manifests/index.ts';
import '../shared/schema/kinds.ts';   // 加载时核对 kinds.ts 的字面量名单和清单一致

/** 读规则表、看 /files 函数在不在、取生成器（前端 B 的 build/gen_files_rules.mjs）的 renderFilesRules；都按仓库根目录找 */
async function filesRulesInput(): Promise<FilesRulesInput> {
  const root = new URL('../', import.meta.url);
  const read = async (p: string) => { try { return await Deno.readTextFile(new URL(p, root)); } catch { return null; } };
  const exists = async (p: string) => { try { await Deno.stat(new URL(p, root)); return true; } catch { return false; } };
  let render: FilesRulesInput['render'];
  if (await exists('build/gen_files_rules.mjs')) {
    // 路径放在变量里：生成器还没合进来时 deno check 不去解析它
    const spec = new URL('build/gen_files_rules.mjs', root).href;
    const mod = await import(spec) as { renderFilesRules?: FilesRulesInput['render'] };
    render = mod.renderFilesRules;
  }
  return { generated: await read(FILES_RULES_PATH), functionExists: await exists(FILES_FUNCTION_DIR), render };
}

const url = Deno.env.get('D1_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  // postgres.js 不知道每条 SQL 的列，结果行的形状由 checks.ts 的调用处写明
  const query: Query = <T extends object>(text: string, params: unknown[] = []) => sql.unsafe(text, params as never[]) as unknown as Promise<T[]>;
  const problems = await runD1(query, allManifests);
  const rules = checkFilesRules(await filesRulesInput(), allManifests);
  problems.push(...rules.problems);
  for (const n of rules.notes) console.log('  说明：' + n);
  if (problems.length) {
    console.error(`D1 不通过：${problems.length} 处`);
    for (const p of problems) console.error('  ' + p);
    Deno.exit(1);
  }
  console.log('D1 通过：数据库和数据清单、授权白名单、/files 规则表一致');
} finally {
  await sql.end();
}
