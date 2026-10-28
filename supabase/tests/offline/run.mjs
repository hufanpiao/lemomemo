// 离线 SQL 检查（没有 Docker 时用）：PGlite（WASM 版 Postgres）+ Supabase 桩，依次跑 7 个迁移、RLS 测试、D1 比对和样例
// 用法：cd supabase/tests/offline && npm ci && node run.mjs [--only=rls|d1|compat]
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
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const problems = await runD1(q, allManifests);
  if (problems.length) { fail(`D1 比对：${problems.length} 处不一致`); problems.forEach((p) => log('    ' + p)); }
  else log('✔ D1 比对：清单和数据库一致');

  const broken = allManifests.map((m) => m.name === 'anniv' ? { ...m, tables: [] } : m);
  const neg = await runD1(q, broken);
  if (neg.some((p) => p.includes('anniversaries'))) log(`✔ D1 反例：少登记 anniversaries 时报错（${neg.length} 处，例：${neg[0]}）`);
  else fail('D1 反例：少登记 anniversaries 却没报错');
}

// 4) 兼容样例：“只加列”的迁移叠在 7 个迁移之上能跑，改名、删列的样例被 compat 检查拦下由前端 B 负责
if (!only || only === 'compat') {
  for (const f of readdirSync(compatDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(compatDir, f), 'utf8');
    try { await db.exec('begin;' + sql + 'rollback;'); log(`✔ 兼容样例 ${f} 能在现有结构上执行`); }
    catch (e) { await db.exec('rollback').catch(() => {}); fail(`兼容样例 ${f}：${e.message}`); }
  }
}

await db.close();
if (failed) { console.log(`\n共 ${failed} 项失败`); process.exit(1); }
console.log('\n全部通过（离线；真库待 Docker，见 B0 实测清单）');
