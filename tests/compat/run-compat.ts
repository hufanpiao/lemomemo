// 旧版客户端契约测试（架构 0.27 第 1 点“测试”、开发计划 v4 三之二、TC-B0-57）。
//
// 做法：拿“基线”那一版的 tests/compat/（契约用例和子集名单），对当前的数据库（CI 先 supabase db reset）跑一遍。
// - 选基线、取出基线的 tests/compat/：运维的 build/compat_baseline.py（resolve / extract），这里不再自己选
//   （B0 集成：原先前端 B 在这里另写了一套选 tag 和 git worktree 的逻辑，和运维的脚本重复，合成一套）；
// - 上线前（基线是 compat-baseline）只报告、不拦，4.0.0 的发布 tag 起必须通过：由 ci.yml 按 resolve 输出的 strict 决定
//   continue-on-error，本脚本只如实返回通过与否；
// - 子集名单读**基线那一版**的 subset.json（格式见 subset.ts）：.test.ts 用例用当前仓库的 Vitest 跑（LEMO_COMPAT_SUBSET=1，
//   harness 只跑名单里的 id）；.sql 用例连数据库在事务里跑，返回 'ok' 才算过。
//
// 用法：
//   node tests/compat/run-compat.ts <基线的 tests/compat 目录>    CI：compat_baseline.py extract 取出来的目录
//   node tests/compat/run-compat.ts                                本机：自己调 compat_baseline.py 选基线、取出
//   加 --sample supabase/tests/compat/sample_add_column.psql        先把兼容样例迁移叠到数据库上，再看结果和样例头上的
//                                                                  expect-old-client 是否一致（TC-B0-57 验证机制用；会改库，只在一次性的本地库上用）
// 环境变量（supabase status -o env 给的本地值）：API_URL、ANON_KEY（.test.ts 用例），DB_URL（.sql 用例和 --sample；也认 LEMO_TEST_DB_URL）
// 需要 Node 22.18 以上（直接跑 .ts）。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSqlCase, sampleExpectation } from './sql-case.ts';
import { parseSubset, sqlCases, testFiles } from './subset.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 基线用例放进仓库里（.gitignore），这样 import 'vitest'、npm 包能找到根目录的 node_modules */
export const BASE_DIR = '.compat-base';

export interface Args {
  dir: string | null;
  sample: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  let dir: string | null = null;
  let sample: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') {
      sample = argv[++i] ?? null;
      if (!sample) throw new Error('--sample 后面要写样例文件');
    } else if (a?.startsWith('--')) {
      throw new Error(`不认识的参数：${a}`);
    } else if (a) {
      if (dir) throw new Error('只能给一个基线目录');
      dir = a;
    }
  }
  return { dir, sample };
}

/**
 * 子集里有 .test.ts 用例时必须给本地 Supabase 的地址：harness 没有地址时整条 it.skip，
 * Vitest 照样退出 0，旧版契约就“全部通过”了却一条也没跑（B0 第①环复查补）。返回缺的变量名，齐了返回空数组。
 */
export function missingSupabaseEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const missing: string[] = [];
  if (!(env.LEMO_TEST_SUPABASE_URL ?? env.API_URL)) missing.push('API_URL');
  if (!(env.LEMO_TEST_ANON_KEY ?? env.ANON_KEY)) missing.push('ANON_KEY');
  return missing;
}

function python(args: string[]): string {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, ['-I', join(ROOT, 'build', 'compat_baseline.py'), ...args], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`compat_baseline.py ${args[0]} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
}

/** 本机没给目录时：按运维的规则选基线、取出来；没有基线返回 null */
function extractBaseline(): string | null {
  const out = python(['resolve']);
  const ref = /^ref=(.*)$/m.exec(out)?.[1]?.trim() ?? '';
  if (!ref) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'lemo-compat-'));
  python(['extract', ref, tmp]);
  console.log(`compat：基线 ${ref}（${/^strict=true$/m.test(out) ? '必须通过' : '只报告、不拦'}）`);
  return join(tmp, 'tests', 'compat');
}

async function withDb<T>(fn: (exec: (s: string) => Promise<unknown>, query: (s: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const url = process.env.LEMO_TEST_DB_URL ?? process.env.DB_URL;
  if (!url) throw new Error('compat：SQL 用例要连数据库，没有 DB_URL（先 supabase start，再 eval "$(supabase status -o env)"）');
  const { default: postgres } = await import('postgres');
  // max: 1：begin … rollback 要在同一个连接上
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await fn(
      (s) => sql.unsafe(s),
      async (s) => [...(await sql.unsafe(s))] as Record<string, unknown>[],
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const src = args.dir ? resolve(args.dir) : extractBaseline();
  if (!src) {
    console.log('compat：还没有发布 tag，也没有 compat-baseline，跳过（4.0.0 第一次没有上一个 tag）');
    return 0;
  }
  const base = join(ROOT, BASE_DIR);
  try {
    const subsetPath = join(src, 'subset.json');
    if (!existsSync(subsetPath)) {
      console.log('compat：基线里没有 tests/compat/subset.json，跳过');
      return 0;
    }
    return await runBaseline(args, src, subsetPath, base);
  } finally {
    // 出错也要清掉：本机自己取出来的临时目录、仓库里的 .compat-base/
    if (!args.dir) rmSync(dirname(dirname(src)), { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
}

async function runBaseline(args: Args, src: string, subsetPath: string, base: string): Promise<number> {
  const subset = parseSubset(readFileSync(subsetPath, 'utf8'));
  const files = testFiles(subset).map((f) => `${BASE_DIR}/${f}`);
  const missing = files.length ? missingSupabaseEnv(process.env) : [];
  if (missing.length) {
    throw new Error(`compat：子集里有 .test.ts 用例，要本地 Supabase 的 ${missing.join('、')}（先 supabase start，再 eval "$(supabase status -o env)"）；没有的话用例全被跳过、看起来像通过`);
  }
  rmSync(base, { recursive: true, force: true });
  cpSync(src, join(base, 'tests', 'compat'), { recursive: true });

  const sample = args.sample ? readFileSync(resolve(ROOT, args.sample), 'utf8') : undefined;
  if (sample) {
    // .test.ts 用例走 HTTP，样例要真的落到库里；.sql 用例另在自己的事务里再叠一次
    await withDb(async (exec) => exec(sample));
    console.log(`compat：已把兼容样例 ${args.sample} 叠到数据库上`);
  }

  let ok = true;
  if (files.length) {
    const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const r = spawnSync(process.execPath, [vitest, 'run', '--config', 'tests/compat/vitest.compat.config.ts', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, LEMO_COMPAT_SUBSET: '1' },
    });
    ok = r.status === 0 && ok;
  }

  const sqls = sqlCases(subset);
  if (sqls.length) {
    const helpersSql = readFileSync(join(ROOT, 'supabase', 'tests', 'rls', '_helpers.psql'), 'utf8');
    await withDb(async (exec, query) => {
      for (const c of sqls) {
        const caseSql = readFileSync(join(base, c.file), 'utf8');
        const result = await runSqlCase(exec, query, { caseSql, helpersSql });
        console.log(`compat：[${c.id}] ${result === 'ok' ? '通过' : `失败：${result}`}`);
        if (result !== 'ok') ok = false;
      }
    });
  }

  if (sample) {
    const want = sampleExpectation(sample);
    const same = (want === 'ok') === ok;
    console.log(`compat：样例预期旧版${want === 'ok' ? '照常' : '失败'}，实际${ok ? '全部通过' : '有失败'} → ${same ? '符合' : '不符合'}`);
    return same ? 0 : 1;
  }
  console.log(`compat：旧版契约子集${ok ? '全部通过' : '有失败'}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
