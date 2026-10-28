// 离线 SQL 检查（没有 Docker 时用）：PGlite（WASM 版 Postgres）+ Supabase 桩，依次跑 7 个迁移、RLS 测试、D1 比对和样例
// 用法（仓库根目录，依赖用根目录的 package.json）：npm run test:db:offline [-- --only=rls|d1|compat|fn]
//   即 node supabase/tests/offline/run.mjs [--only=…]
// 不代替 supabase db reset / supabase test db：桩不是 Supabase 的真实定义，pg_cron、pg_net 被跳过，真库差异见 B0 实测清单
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const migDir = join(root, 'supabase/migrations');
const rlsDir = join(root, 'supabase/tests/rls');
const compatDir = join(root, 'supabase/tests/compat');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

let failed = 0;
const log = (s) => console.log(s);
const fail = (s) => { failed++; console.log('✘ ' + s); };

// 真库没有的扩展跳过（pg_cron、pg_net）；cron.schedule 由桩接住
const stripExt = (sql) => sql.replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;/gim, '-- (离线跳过) $&');
// psql 的 \ir 由这里内联（pg_prove 走 psql，真库原样支持）
const inlineIncludes = (sql, dir) => sql.replace(/^\\ir\s+(\S+)\s*$/gm, (_, f) => readFileSync(join(dir, f), 'utf8'));

async function freshDb({ migrations = true } = {}) {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(readFileSync(join(here, 'supabase-stub.sql'), 'utf8'));
  await db.exec(readFileSync(join(here, 'tap-shim.sql'), 'utf8'));
  await db.exec(`alter role postgres set search_path = "$user", public, extensions; set search_path = "$user", public, extensions;`);
  if (migrations) {
    for (const f of readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      try { await db.exec(stripExt(readFileSync(join(migDir, f), 'utf8'))); }
      catch (e) { throw new Error(`迁移 ${f} 失败：${e.message}`); }
    }
  }
  return db;
}

// 跑一个 pgTAP 风格的测试文件，返回 not ok 的行
async function runTap(db, file) {
  const sql = inlineIncludes(readFileSync(file, 'utf8'), dirname(file));
  let res;
  try { res = await db.exec(sql); }
  catch (e) { await db.exec('rollback').catch(() => {}); return { lines: [], errors: [`执行出错：${e.message}`] }; }
  const lines = res.flatMap((r) => r.rows.flatMap((row) => Object.values(row))).filter((v) => typeof v === 'string');
  const errors = lines.filter((l) => l.startsWith('not ok') || l.startsWith('# Looks like'));
  return { lines, errors };
}

// 0) supabase test db 只能跑 supabase/tests/rls（0.31 第 22 条）：CLI 用 pg_prove --ext .sql -r 递归跑给它的目录，
//    不给路径就是整个 supabase/tests，会把 d1-fixtures、compat 的样例和本目录的桩当测试执行（还会改本地库）。
//    所以 package.json 的 test:db 必须写明路径；CI 跑的就是 npm run test:db
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/\bsupabase test db supabase\/tests\/rls(\s|&|$)/.test(pkg.scripts?.['test:db'] ?? '')) fail('package.json 的 test:db 没把 supabase test db 限定在 supabase/tests/rls');
  else log('✔ test:db 只让 supabase test db 跑 supabase/tests/rls');
}

// 1) 迁移
const db = await freshDb();
log('✔ 7 个迁移在 PGlite 上依次执行成功');

// 2) RLS 测试
if (!only || only === 'rls') {
  for (const f of readdirSync(rlsDir).filter((f) => f.endsWith('.test.sql')).sort()) {
    const { lines, errors } = await runTap(db, join(rlsDir, f));
    const n = lines.filter((l) => /^(not )?ok \d+/.test(l)).length;
    if (errors.length) { fail(`${f}：${errors.length} 处失败 / 共 ${n}`); errors.forEach((e) => log('    ' + e.replace(/\n/g, '\n    '))); }
    else log(`✔ ${f}：${n} 条全过`);
  }
}

// 3) D1：清单和数据库比对；再用“故意少登记一张表”的清单证明 D1 会失败
if (!only || only === 'd1') {
  const { runD1 } = await import('../../../build/d1/checks.ts');
  const { allManifests } = await import('../../../shared/manifests/index.ts');
  const kinds = await import('../../../shared/schema/kinds.ts');   // 加载时核对字面量名单和清单一致，不一致直接抛错
  log(`✔ kinds.ts 和清单一致：向量类型 ${kinds.VECTOR_KINDS.join('、')}`);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const problems = await runD1(q, allManifests);
  if (problems.length) { fail(`D1 比对：${problems.length} 处不一致`); problems.forEach((p) => log('    ' + p)); }
  else log('✔ D1 比对：清单和数据库一致');

  const broken = allManifests.map((m) => m.feature === 'anniv' ? { ...m, tables: [] } : m);
  const neg = await runD1(q, broken);
  if (neg.some((p) => p.includes('anniversaries'))) log(`✔ D1 反例：少登记 anniversaries 时报错（${neg.length} 处，例：${neg[0]}）`);
  else fail('D1 反例：少登记 anniversaries 却没报错');

  // 违规样例：每个样例在事务里改一处，D1 必须报出 expect 那句，然后回滚
  const fxDir = join(root, 'supabase/tests/d1-fixtures');
  for (const f of readdirSync(fxDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(fxDir, f), 'utf8');
    const expect = /^-- expect: (.+)$/m.exec(sql)?.[1]?.trim();
    await db.exec('begin');
    try {
      await db.exec(sql);
      const ps = await runD1(q, allManifests);
      if (expect && ps.some((p) => p.includes(expect))) log(`✔ D1 违规样例 ${f}：报出“${ps.find((p) => p.includes(expect))}”`);
      else fail(`D1 违规样例 ${f}：没报出“${expect}”（实际：${ps.join(' | ') || '无'}）`);
    } catch (e) { fail(`D1 违规样例 ${f} 执行出错：${e.message}`); }
    await db.exec('rollback');
  }

  // 清单本身的违规（zod 在加载时拦下，TC-B0-24、26）
  const { defineManifest } = await import('../../../shared/schema/manifest.ts');
  const base = { name: 'qa', schema: 'public', sync: false, realtime: false, localCache: 'none', clientWritable: ['a'], softDelete: false,
    backup: 'none', export: 'none', onAccountDelete: 'cascade' };
  const bads = [
    ['systemCols 和 clientWritable 重叠', { ...base, userLookup: { by: 'column', col: 'user_id' }, systemCols: ['a'], noConflict: [] }],
    ['userLookup 和 noUserData 同时写', { ...base, userLookup: { by: 'column', col: 'user_id' }, noUserData: true }],
    ['userLookup 和 noUserData 都没写', { ...base }],
    ['noConflict 放了不可写的列', { ...base, userLookup: { by: 'column', col: 'user_id' }, systemCols: [], noConflict: ['b'] }],
  ];
  for (const [what, t] of bads) {
    try { defineManifest({ feature: 'qa', owner: 'feature', tables: [t] }); fail(`清单违规“${what}”没被拦下`); }
    catch { log(`✔ 清单违规“${what}”加载时报错`); }
  }
}

// 4) 兼容样例：每个样例叠在 7 个迁移之上，再跑一遍 tests/compat/subset.json 里的 SQL 契约用例（4.0.0 客户端的写法），
//    结果和样例头上的 expect-old-client 比。跑法和 CI 的 tests/compat/run-compat.ts 是同一个函数（tests/compat/sql-case.ts，B0 集成）
//    迁移文件里出现 rename column / drop column 由前端 B 的 compat 检查拦下
if (!only || only === 'compat') {
  const { runSqlCase, sampleExpectation } = await import('../../../tests/compat/sql-case.ts');
  const { parseSubset, sqlCases } = await import('../../../tests/compat/subset.ts');
  const subset = parseSubset(readFileSync(join(root, 'tests/compat/subset.json'), 'utf8'));
  const cases = sqlCases(subset);
  if (cases.length === 0) fail('tests/compat/subset.json 里没有 SQL 契约用例，兼容样例没东西可验');
  const helpersSql = readFileSync(join(rlsDir, '_helpers.psql'), 'utf8');
  const exec = (sql) => db.exec(sql);
  const query = async (sql) => (await db.query(sql)).rows;
  for (const f of readdirSync(compatDir).filter((f) => f.endsWith('.sql') && !f.startsWith('_')).sort()) {
    const sampleSql = readFileSync(join(compatDir, f), 'utf8');
    try {
      const expect = sampleExpectation(sampleSql);
      const results = [];
      for (const c of cases) results.push([c.id, await runSqlCase(exec, query, { caseSql: readFileSync(join(root, c.file), 'utf8'), helpersSql, sampleSql })]);
      const ok = results.every(([, r]) => r === 'ok');
      const detail = results.filter(([, r]) => r !== 'ok').map(([id, r]) => `${id}：${r.split(' ')[0]}`).join('，');
      if ((expect === 'ok') === ok) log(`✔ 兼容样例 ${f}：旧版客户端${ok ? '照常读写' : `写入失败（${detail}），符合预期`}`);
      else fail(`兼容样例 ${f}：预期 ${expect}，实际 ${ok ? 'ok' : detail}`);
    } catch (e) { fail(`兼容样例 ${f} 执行出错：${e.message}`); }
  }
}

// 5) functions/_shared/auth.ts：假客户端走一遍 requireActiveUser 的各分支
if (!only || only === 'fn') {
  const { checkAuth } = await import('./auth-check.mjs');
  const { n, fails } = await checkAuth();
  if (fails.length) { fail(`requireActiveUser：${fails.length} 处不对`); fails.forEach((f) => log('    ' + f)); }
  else log(`✔ requireActiveUser、isUsable：${n} 个分支全对`);
}

await db.close();
if (failed) { console.log(`\n共 ${failed} 项失败`); process.exit(1); }
console.log('\n全部通过（离线；真库待 Docker，见 B0 实测清单）');
