// TC-B0-02 的后半（QA D-06）：架构 2.3 规则表里的每一条规则，tests/arch-fixtures/ 里至少有一个违规样例，
// 少一条就报“规则无违规样例”。按规则号核（读架构文档 2.3 的表），不按 ESLint 规则名核——
// 同一个 ESLint 规则 id 下挂了好几条架构规则，删掉其中一条的全部样例，按规则名核是发现不了的（QA 改坏抽查 10）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixtures, ROOT } from './fixture-header.ts';

/** 架构 2.3 的规则号：表格每行第一格（“A1 / A8”算 A1 一条，A8 在同一格里一起管）；
 *  规则号后可带括号说明，如 `| **A28**（0.33） |`、`| **A29**（0.33，UI-4 L-4，B1） |`（代码审查第二轮低 7） */
export function rulesOfArch2_3(doc: string): string[] {
  const start = doc.indexOf('### 2.3 ');
  const end = doc.indexOf('\n### ', start + 1);
  if (start < 0 || end < 0) throw new Error('架构文档里找不到 2.3 节');
  const ids: string[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const m = /^\|\s*(?:\*\*)?([A-Z]\d+)(?:\s*\/\s*[A-Z]\d+)?(?:\*\*)?\s*(?:[（(][^）)|]*[）)])?\s*\|/.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/** 每条规则的违规样例在哪：各目录的样例文件头 rule=、check_arch 的样例目录名前缀、D1 的 .psql、W3 的构建目录 */
export function violationSamples(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (rule: string, where: string) => out.set(rule, [...(out.get(rule) ?? []), where]);
  for (const sub of ['eslint', 'stylelint', 'tsc']) {
    for (const f of loadFixtures(sub)) if (f.expect.length > 0 && f.rule) add(f.rule, `${sub}/${f.file}`);
  }
  // check_arch：每个样例是一棵迷你仓库，目录名以规则号开头（a14-env、w2-missing…）；以 -ok 结尾的是对照组
  for (const d of readdirSync(join(FIXTURES, 'check_arch'))) {
    if (d.endsWith('-ok')) continue;
    const id = /^([a-z]\d+)-/.exec(d)?.[1];
    if (id) add(id.toUpperCase(), `check_arch/${d}`);
  }
  // check_backend：A28 是 F1～F3 三项（架构 2.3 A28 ①②③）；F4、F5、F6、M1～M6 同一脚本另查、不另编 A 号，不映射
  for (const d of readdirSync(join(FIXTURES, 'check_backend'))) if (/^f[1-3]-/.test(d)) add('A28', `check_backend/${d}`);
  for (const f of readdirSync(join(ROOT, 'supabase', 'tests', 'd1-fixtures'))) if (f.endsWith('.psql')) add('D1', `d1-fixtures/${f}`);
  for (const d of readdirSync(join(FIXTURES, 'check_size'))) if (d.startsWith('w3-')) add('W3', `check_size/${d}`);
  return out;
}

/** “B1 落地”待办：规则表里已登记、标明 B1 才落地的规则，B0 暂不要求违规样例（落地时从这里删掉） */
export const B1_PENDING: readonly string[] = [
];

describe('架构 2.3：每条规则都有违规样例（按规则号核）', () => {
  const doc = readFileSync(join(ROOT, 'docs', '10-架构', '架构设计-v4.md'), 'utf8');
  const rules = rulesOfArch2_3(doc);

  it('规则表读出来是完整的（防止表格格式一变就什么都不核）', () => {
    for (const r of ['A1', 'A2', 'A11', 'A12', 'A13', 'A14', 'A15', 'A18', 'A19', 'A20', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A28', 'A29', 'A30', 'A31', 'D1', 'T1', 'T2', 'T3', 'W1', 'W2', 'W3']) {
      expect(rules).toContain(r);
    }
  });

  it('每条规则至少一个违规样例，缺了报“规则无违规样例”', () => {
    const samples = violationSamples();
    const missing = rules.filter((r) => !B1_PENDING.includes(r) && (samples.get(r) ?? []).length === 0).map((r) => `${r}：规则无违规样例`);
    expect(missing).toEqual([]);
  });

  it('“B1 落地”待办名单里的规则都还在规则表里（删了规则要同步删名单）', () => {
    expect(B1_PENDING.filter((r) => !rules.includes(r))).toEqual([]);
  });

  it('A28 的样例是 check_backend 的 f1～f3', () => {
    const a28 = violationSamples().get('A28') ?? [];
    for (const p of ['f1-', 'f2-', 'f3-']) expect(a28.some((x) => x.startsWith(`check_backend/${p}`))).toBe(true);
    expect(a28.every((x) => /^check_backend\/f[1-3]-/.test(x))).toBe(true);
  });

  it('样例写的规则号都在规则表里（写错号等于没写）；规则表以外的只认 0.31 / 2.0 等单列的几条', () => {
    const extra = new Set(['2.4', 'R2', 'P142']);
    const unknown = [...violationSamples().keys()].filter((r) => !rules.includes(r) && !extra.has(r));
    expect(unknown).toEqual([]);
  });

  it('自证：拿掉某条规则的全部样例（例如 A13，QA 改坏抽查 10），这里一定报出来', () => {
    const samples = violationSamples();
    samples.delete('A13');
    const missing = rules.filter((r) => !B1_PENDING.includes(r) && (samples.get(r) ?? []).length === 0);
    expect(missing).toEqual(['A13']);
  });

  it('W3 的样例目录确实有 manifest', () => {
    expect(existsSync(join(FIXTURES, 'check_size', 'w3-over-budget', 'manifest.json'))).toBe(true);
  });
});

// Vitest 的 node / node-slow 分组（vitest.config.ts）：起子进程、真跑 ESLint / stylelint / TypeScript / PGlite 的测试文件
// 必须登记在 SLOW_NODE_TESTS（30 秒超时、限并发）；漏登记就留在 node 里按 5 秒算，机器一忙就偶发超时
// 只认 import 语句（静态 from、动态 import()）里的模块名，注释和普通字符串里提到不算
const HEAVY = /(?:from\s*|import\(\s*)['"](?:node:child_process|eslint|stylelint|typescript|@electric-sql\/pglite[^'"]*)['"]/;
const NODE_TEST_DIRS = ['shared', 'arch', 'build', 'functions', 'edge', 'data-manifest'];
/** 扫出来是重型、其实不起进程的：只用到辅助模块里的纯函数（写明理由；不再被扫出时要删掉） */
const NOT_HEAVY: Readonly<Record<string, string>> = {
  'tests/build/run-compat.test.ts': '只用 tests/compat/run-compat.ts 的 parseArgs、missingSupabaseEnv，不起 vitest 子进程',
  // 下面三个经 tools/e2e/real-backend.mjs（它的 up、check 等子命令用 spawnSync 起 supabase CLI、npm）被扫出，只用护栏、改写、取状态的纯函数
  'tests/build/e2e-real-backend.test.ts': '只用 tools/e2e/real-backend.mjs 的护栏、config 改写等纯函数，不起子进程（文件头写明）',
  'tests/build/e2e-real-backend-bypass.test.ts': '只用 tools/e2e/real-backend.mjs 的 checkGuard、rewriteConfig 等纯函数，不起子进程',
  'tests/build/e2e-real-backend-env.test.ts': '只用 tools/e2e/real-backend.mjs 的 pickEnv、functionsEnvText 等纯函数，不起子进程',
};

/** 会起子进程的导出（模块路径相对仓库根）：NOT_HEAVY 里的文件和它引的 tests/ 辅助模块都不许导入，也不许整体导入这些模块 */
const SPAWNING_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  'tools/e2e/real-backend.mjs': ['statusEnv'], // 起 supabase CLI（spawnSync）；其余导出是纯函数、常量
};

/** file 及它经相对路径引到的 tests/ 辅助模块（递归）从 SPAWNING_EXPORTS 模块导入的禁用名；整体导入（* as、默认导入、import()）记 '*' */
export function spawningImports(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: string[] = [];
  const src = readFileSync(file, 'utf8');
  const found = [
    ...[...src.matchAll(/\bimport\s+([^'";]*?)\s*from\s*'(\.{1,2}\/[^']+\.(?:ts|mjs))'/g)].map((m) => [m[1] ?? '', m[2] ?? ''] as const),
    ...[...src.matchAll(/\bimport\(\s*'(\.{1,2}\/[^']+\.(?:ts|mjs))'/g)].map((m) => ['*', m[1] ?? ''] as const),
  ];
  for (const [clause, spec] of found) {
    const dep = join(file, '..', spec);
    const rel = dep.slice(ROOT.length + 1).replaceAll('\\', '/');
    const banned = SPAWNING_EXPORTS[rel];
    if (!banned) {
      if (dep.startsWith(join(ROOT, 'tests') + sep) && !dep.endsWith('.test.ts') && existsSync(dep)) out.push(...spawningImports(dep, seen));
      continue;
    }
    if (/^type\b/.test(clause)) continue; // 只导入类型，不会执行
    if (clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim() !== '') out.push(`${rel}:*`);
    const names = (/\{([^}]*)\}/.exec(clause)?.[1] ?? '').split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '');
    out.push(...names.filter((n) => banned.includes(n)).map((n) => `${rel}:${n}`));
  }
  return out;
}

/** 顺着相对引用跟进的范围：tests/ 下的辅助模块、tools/ 下的脚本（.ts、.mjs；测试文件本身不跟） */
const FOLLOW_DIRS = [join(ROOT, 'tests') + sep, join(ROOT, 'tools') + sep];

/** 文件本身或它经相对路径引到的 tests/、tools/ 下模块（递归）里有没有重型标记（E2E-watchdog-sugg ②：跟进 tools/**\/*.mjs） */
export function isHeavy(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  if (HEAVY.test(src)) return true;
  for (const m of src.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+\.(?:ts|mjs))'/g)) {
    const dep = join(file, '..', m[1] ?? '');
    if (FOLLOW_DIRS.some((d) => dep.startsWith(d)) && !dep.endsWith('.test.ts') && existsSync(dep) && isHeavy(dep, seen)) return true;
  }
  return false;
}

function nodeTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts')) out.push(p.slice(ROOT.length + 1).replaceAll('\\', '/'));
    }
  };
  for (const d of NODE_TEST_DIRS) walk(join(ROOT, 'tests', d));
  return out.sort();
}

describe('Vitest 分组：重型测试都在 node-slow（vitest.config.ts 的 SLOW_NODE_TESTS）', () => {
  it('起子进程或用 ESLint / stylelint / TypeScript / PGlite 的测试文件都登记了；登记的都还是重型的、文件都在', async () => {
    const { SLOW_NODE_TESTS } = await import('../../vitest.config.ts');
    const flagged = nodeTestFiles().filter((f) => isHeavy(join(ROOT, f)));
    expect(Object.keys(NOT_HEAVY).filter((f) => !flagged.includes(f))).toEqual([]);
    const heavy = flagged.filter((f) => !(f in NOT_HEAVY));
    expect(heavy.filter((f) => !SLOW_NODE_TESTS.includes(f))).toEqual([]);
    expect(SLOW_NODE_TESTS.filter((f) => !heavy.includes(f))).toEqual([]);
  });

  it('自证：只经辅助模块起子进程的文件（login-token-tests-run 经 login-token-fake）也认得出；纯逻辑的不算', () => {
    expect(isHeavy(join(ROOT, 'tests/build/login-token-tests-run.test.ts'))).toBe(true);
    expect(isHeavy(join(ROOT, 'tests/build/objstore-fake.test.ts'))).toBe(false);
    expect(isHeavy(join(ROOT, 'tests/data-manifest/objstore-cases.test.ts'))).toBe(false);
  });

  it('NOT_HEAVY 里的文件（连同它引的 tests/ 辅助模块）不导入会起子进程的导出（real-backend.mjs 的 statusEnv 等），也不整体导入', () => {
    expect(Object.keys(NOT_HEAVY).flatMap((f) => spawningImports(join(ROOT, f)).map((x) => `${f} → ${x}`))).toEqual([]);
    // 自证：playwright.real.config.ts 确实导入了 statusEnv，这里认得出
    expect(spawningImports(join(ROOT, 'playwright.real.config.ts'))).toEqual(['tools/e2e/real-backend.mjs:statusEnv']);
  });

  it('自证：只经 tools/ 下 .mjs 起子进程的文件（e2e-watchdog 经 tools/e2e/run-watchdog.mjs）也认得出，它本身没有重型标记', () => {
    const f = join(ROOT, 'tests/build/e2e-watchdog.test.ts');
    expect(HEAVY.test(readFileSync(f, 'utf8'))).toBe(false);
    expect(isHeavy(f)).toBe(true);
    expect(isHeavy(join(ROOT, 'tools/e2e/run-watchdog.mjs'))).toBe(true);
    // 引了 tools/ 但那边不起子进程的不算
    expect(isHeavy(join(ROOT, 'tests/build/preview-login.test.ts'))).toBe(false);
  });
});
