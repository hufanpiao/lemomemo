// D1 的反例和违规样例，打真库（ci.yml 的 db 任务；离线版在 supabase/tests/offline/run.mjs 第 3 段，同一套样例、同一个 runD1）
// 证明 D1 在真 Supabase 上也“拦得住”，不只是 PGlite 加桩时拦得住（B0 集成回报：原先只在 unit.yml 离线跑）
//   0) 正例再确认一次（库本身不干净时，“报出来了”说明不了问题）
//   1) 反例：清单故意少登记 anniversaries，D1 必须报出 anniversaries
//   2) 违规样例 supabase/tests/d1-fixtures/*.psql：每个在事务里改一处，D1 必须报出样例头上 `-- expect:` 那句，然后回滚
// 前提：supabase db reset 刚跑过。样例都在事务里执行并回滚，跑完库不变
// 用法（仓库根目录）：D1_DB_URL=<supabase status 的 DB_URL> node build/ci/d1_negative.mjs
//   连接串取 D1_DB_URL，默认是 supabase start 的本地库；不读 SUPABASE_DB_URL（TC-B0-35）
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');
const fxDir = join(root, 'supabase', 'tests', 'd1-fixtures');

/**
 * q(sql, params) 返回结果行；exec(sql) 执行可能含多句的 SQL。两者必须在同一个连接上（begin … rollback）
 * 返回失败说明的列表，空 = 全部报出
 */
export async function runNegative(q, exec, log = console.log) {
  const { runD1 } = await import('../d1/checks.ts');
  const { allManifests } = await import('../../shared/manifests/index.ts');
  const fails = [];

  const base = await runD1(q, allManifests);
  if (base.length) return [`D1 正例就不通过（${base.length} 处），违规样例不跑：${base.join(' | ')}`];

  const broken = allManifests.map((m) => (m.feature === 'anniv' ? { ...m, tables: [] } : m));
  const neg = await runD1(q, broken);
  if (neg.some((p) => p.includes('anniversaries'))) log(`✔ D1 反例：少登记 anniversaries 时报错（${neg.length} 处，例：${neg[0]}）`);
  else fails.push('D1 反例：清单少登记 anniversaries，却没报错');

  const files = readdirSync(fxDir).filter((f) => f.endsWith('.psql')).sort();
  if (files.length === 0) fails.push('supabase/tests/d1-fixtures/ 里没有违规样例（.psql）');
  for (const f of files) {
    const text = readFileSync(join(fxDir, f), 'utf8');
    const expect = /^-- expect: (.+)$/m.exec(text)?.[1]?.trim();
    if (!expect) { fails.push(`D1 违规样例 ${f}：头上没有“-- expect: …”`); continue; }
    await exec('begin');
    try {
      await exec(text);
      const ps = await runD1(q, allManifests);
      const hit = ps.find((p) => p.includes(expect));
      if (hit) log(`✔ D1 违规样例 ${f}：报出“${hit}”`);
      else fails.push(`D1 违规样例 ${f}：没报出“${expect}”（实际：${ps.join(' | ') || '无'}）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 代码审查第三轮低：25、26 在 auth.users 上 drop / create trigger，真 Supabase 上 postgres 不一定是属主。
      //   这种情况单独、明确地报出来（照样算失败），不和别的执行错误混在一起：说明这个样例在真库上没证明任何东西
      if (/must be owner/i.test(msg)) {
        fails.push(`D1 违规样例 ${f} 在真库上没有权限执行（${msg}）：postgres 不是表的属主，这一支在真库上证明不了，`
          + '只有离线 PGlite（npm run test:db:offline）和 tests/build/d1-guard-no-password.test.ts 证明过；'
          + '要么换有属主权限的连接跑这个样例，要么把它挪出 d1-fixtures（改成只在离线跑）并在 B1 接手清单记下');
      } else {
        fails.push(`D1 违规样例 ${f} 执行出错：${msg}`);
      }
    } finally {
      await exec('rollback');
    }
  }
  return fails;
}

async function main() {
  const { default: postgres } = await import('postgres');
  const url = process.env.D1_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const conn = await sql.reserve();
  let fails;
  try {
    fails = await runNegative(
      async (text, params = []) => [...(await conn.unsafe(text, params))],
      // 不带参数时 postgres.js 走简单查询协议，一次可以执行多句
      (text) => conn.unsafe(text),
    );
  } finally {
    conn.release();
    await sql.end({ timeout: 5 });
  }
  for (const f of fails) console.log(`::error::${f}`);
  console.log(fails.length ? `\nD1 反例和违规样例（真库）：${fails.length} 项失败` : '\nD1 反例和违规样例（真库）：全部报出');
  return fails.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error(`::error::D1 反例和违规样例没跑完：${e instanceof Error ? e.message : e}`); process.exit(1); },
  );
}
