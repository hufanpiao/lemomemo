// 函数侧版本门的覆盖核对（B1 K10；架构第 6 节“所有函数都检查 X-App-Version”、0.27 第 1 点“名单外的函数一律查”）：
// supabase/functions/ 下每个函数（不含下划线开头的 _shared、_preview）都要在下面的 PLAN 里标“查”或“免哪些方法”，
// 而且和唯一的免查名单 shared/version-gate-list.ts 一致；新加函数不标就失败，提醒同一个 PR 里接上版本门或进免查名单。
// 标“查”的函数还要核对源码里真的接了（K10 复审：在 TypeScript 语法树上判断，注释不算）：
// • 入口处查：index.ts 里 `await versionGate('<名>', req` 出现在 `handle(` 之前；
// • core 里查：core.ts 从 _shared/version-gate-core.ts import blockedMin（不准自己定义同名函数、变量）并调用它，
//   而且 index.ts 从 _shared/version-gate.ts import 并调用 cachedMinClientVersion（读配置走缓存和超时，0.38 第 52 条）；
// • 免查 POST、只收 POST 的函数：handle 函数体的前 3 条语句里有 `if (req.method !== 'POST') return …`，实际不查，可以不接。
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { checkExemptFunctions, checkMigrationMins, minVersionFindings, minVersionLiterals } from '../../build/check_version_gate.mjs';
import { FUNCTION_VERSION_EXEMPTIONS } from '../../shared/version-gate-list.ts';

const FN_DIR = resolve(import.meta.dirname, '../../supabase/functions');

/** 每个函数：'check' = 一律查；数组 = 免查的方法（其余方法照查） */
const PLAN = new Map<string, 'check' | readonly string[]>([
  ['invite-signup', 'check'],       // K2：core.ts 的 start、verify 自己查（Turnstile、限流之后）
  ['account', ['POST']],            // K3：0.38 第 47 条，只免 POST
  ['account-purge', ['POST']],      // K3：pg_cron 带 x-cron-secret
  ['usage-report', ['POST']],       // K15：lemo-ops 带 x-ops-secret
]);

/** 接入代码等审查通过再加的目录；接上以后从这里删掉（K10 安全审查后：invite-signup 已接，account 只收 POST、不接） */
const PENDING_WIRING = new Set<string>();

/** 去掉注释：交给 TypeScript 编译一遍（removeComments），字符串、正则里的 // 不会误删 */
function stripComments(code: string): string {
  return ts.transpileModule(code, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 所有直接写名字的调用 */
function calledNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** 从结尾是 specEnd 的模块具名 import 了 name */
function importsFrom(sf: ts.SourceFile, specEnd: string, name: string): boolean {
  return sf.statements.some((st) => {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.endsWith(specEnd)) return false;
    const nb = st.importClause?.namedBindings;
    return nb !== undefined && ts.isNamedImports(nb) && nb.elements.some((e) => e.name.text === name);
  });
}

/** 文件里自己声明了 name（函数声明、变量声明） */
function declares(sf: ts.SourceFile, name: string): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name) hit = true;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return hit;
}

/** 入口处查：去掉注释后 `await versionGate('<名>', req` 在 `handle(` 之前 */
function wiredAtIndex(index: string, name: string): boolean {
  const code = stripComments(index);
  const gateAt = code.indexOf(`await versionGate('${name}', req`);
  const handleAt = code.indexOf('handle(');
  return gateAt >= 0 && (handleAt < 0 || gateAt < handleAt);
}

/** core 里查：core.ts import 并调用 blockedMin、不自己定义；index.ts import 并调用 cachedMinClientVersion */
function wiredInCore(index: string, core: string): boolean {
  const c = parse(core);
  const i = parse(index);
  return importsFrom(c, '_shared/version-gate-core.ts', 'blockedMin') && !declares(c, 'blockedMin') && calledNames(c).has('blockedMin')
    && importsFrom(i, '_shared/version-gate.ts', 'cachedMinClientVersion') && calledNames(i).has('cachedMinClientVersion');
}

/** 只收 POST：顶层 handle 函数体前 3 条语句里有 if (req.method !== 'POST') return …（注释、别的函数、太靠后的都不算） */
function postOnlyHandle(core: string): boolean {
  const sf = parse(core);
  const fn = sf.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === 'handle');
  const first = fn?.body?.statements.slice(0, 3) ?? [];
  return first.some((st) => {
    if (!ts.isIfStatement(st)) return false;
    const e = st.expression;
    const cond = ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && e.left.getText(sf) === 'req.method' && ts.isStringLiteral(e.right) && e.right.text === 'POST';
    const then = st.thenStatement;
    const head = ts.isBlock(then) ? then.statements[0] : then;
    return cond && head !== undefined && ts.isReturnStatement(head);
  });
}

function functionDirs(): string[] {
  return readdirSync(FN_DIR)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .filter((n) => statSync(join(FN_DIR, n)).isDirectory())
    .sort();
}

describe('每个函数都标了查或免', () => {
  it('supabase/functions/ 下的函数和 PLAN 一一对应', () => {
    expect(functionDirs()).toEqual([...PLAN.keys()].sort());
  });

  it('PLAN 里免查的方法和 shared/version-gate-list.ts 一致；标“查”的不在名单里', () => {
    for (const [name, plan] of PLAN) {
      const ex = FUNCTION_VERSION_EXEMPTIONS.find((f) => f.name === name);
      if (plan === 'check') expect(ex, name).toBeUndefined();
      else expect([...(ex?.methods ?? [])], name).toEqual([...plan]);
    }
    for (const f of FUNCTION_VERSION_EXEMPTIONS) expect(PLAN.has(f.name), f.name).toBe(true);
  });

  it('要查的方法源码里接上了版本门（审查中的目录除外）', () => {
    for (const [name, plan] of PLAN) {
      if (PENDING_WIRING.has(name)) continue;
      if (plan !== 'check' && plan.includes('*')) continue;
      const read = (f: string) => (existsSync(join(FN_DIR, name, f)) ? readFileSync(join(FN_DIR, name, f), 'utf8') : '');
      const index = read('index.ts');
      const core = read('core.ts');
      const wired = wiredAtIndex(index, name) || wiredInCore(index, core);
      // 免查 POST 而且只收 POST 的函数（其余方法 handle 开头就回 405）实际不查，可以不接
      const postOnly = plan !== 'check' && plan.includes('POST') && postOnlyHandle(core);
      expect(wired || postOnly, `${name}：要查的方法没接版本门`).toBe(true);
    }
  });
});

describe('接入判断本身（K10 复审：正反例）', () => {
  const imp = "import { blockedMin } from '../_shared/version-gate-core.ts';\n";
  const useIt = "function v(req: Request, min: string | null) { return blockedMin(min, req.headers.get('x-app-version')); }\n";
  const idx = "import { cachedMinClientVersion } from '../_shared/version-gate.ts';\nconst m = () => cachedMinClientVersion(async () => null);\n";

  it('入口处查：versionGate 要在 handle( 之前；写在注释里、函数名不对都不算', () => {
    expect(wiredAtIndex("Deno.serve(async (req) => { const b = await versionGate('x', req, l); if (b) return b; return handle(req, d); });", 'x')).toBe(true);
    expect(wiredAtIndex("Deno.serve(async (req) => { const r = handle(req, d); await versionGate('x', req, l); return r; });", 'x')).toBe(false);
    expect(wiredAtIndex("// await versionGate('x', req, l)\nDeno.serve((req) => handle(req, d));", 'x')).toBe(false);
    expect(wiredAtIndex("Deno.serve(async (req) => { await versionGate('y', req, l); return handle(req, d); });", 'x')).toBe(false);
  });

  it('core 里查：要 import blockedMin 并调用，index.ts 要 import 并调用 cachedMinClientVersion', () => {
    expect(wiredInCore(idx, imp + useIt)).toBe(true);
    expect(wiredInCore('const m = () => store.min();\n', imp + useIt), '读配置没走缓存').toBe(false);
    expect(wiredInCore(idx, 'function blockedMin(a: unknown, b: unknown) { return null; }\n' + useIt), '自己定义 blockedMin').toBe(false);
    expect(wiredInCore(idx, imp + 'const blockedMin2 = 1;\n'), 'import 了没调用').toBe(false);
    expect(wiredInCore(idx, imp + 'const blockedMin = () => null;\n' + useIt), '变量遮住 import').toBe(false);
    expect(wiredInCore(idx, "// import { blockedMin } from '../_shared/version-gate-core.ts';\n" + useIt), 'import 只在注释里').toBe(false);
  });

  it("只收 POST：handle 前 3 条语句里的 if (req.method !== 'POST') return；别处、注释、太靠后、不 return 都不算", () => {
    const h = (body: string) => `export async function handle(req: Request, deps: unknown): Promise<Response> {\n${body}\n}`;
    expect(postOnlyHandle(h("if (req.method !== 'POST') return err(405, 'method_not_allowed');\nreturn ok();"))).toBe(true);
    expect(postOnlyHandle(h("const a = 1;\nif (req.method !== 'POST') { return err(405, 'x'); }\nreturn ok();"))).toBe(true);
    expect(postOnlyHandle(h("// if (req.method !== 'POST') return err(405, 'x');\nreturn ok();"))).toBe(false);
    expect(postOnlyHandle(h("const a = 1;\nconst b = 2;\nconst c = 3;\nif (req.method !== 'POST') return err(405, 'x');"))).toBe(false);
    expect(postOnlyHandle(h("if (req.method !== 'GET') return err(405, 'x');"))).toBe(false);
    expect(postOnlyHandle(h("if (req.method !== 'POST') log('x');"))).toBe(false);
    expect(postOnlyHandle("function other(req: Request) { if (req.method !== 'POST') return 1; return 2; }\nexport async function handle(req: Request) { return ok(); }")).toBe(false);
  });

  it('真仓库：account、account-purge、usage-report 只收 POST；invite-signup 在 core 里查', () => {
    const rd = (n: string, f: string) => readFileSync(join(FN_DIR, n, f), 'utf8');
    for (const n of ['account', 'account-purge', 'usage-report']) expect(postOnlyHandle(rd(n, 'core.ts')), n).toBe(true);
    expect(wiredInCore(rd('invite-signup', 'index.ts'), rd('invite-signup', 'core.ts'))).toBe(true);
  });
});

// ---------- build/check_version_gate.mjs 的 K10 安全审查新增检查 ----------

type Entry = { name: string; methods: readonly string[]; caller?: 'client' | 'server' };
const checkList = checkExemptFunctions as (list: readonly Entry[], dir: string) => string[];
const literals = minVersionLiterals as (sql: string) => string[];
const findings = minVersionFindings as (sql: string) => { literals: string[]; opaque: string[] };
const checkMins = checkMigrationMins as (dir: string) => string[];

describe('check_version_gate：方法写法、client 不准 *、迁移里的 min_client_version', () => {
  it('方法只能是大写 HTTP 方法；caller = client 不准用 *；server 可以', () => {
    const errs = (methods: string[], caller?: 'client' | 'server') =>
      checkList([{ name: 'account', methods, ...(caller ? { caller } : {}) }], FN_DIR);
    expect(errs(['POST'], 'client')).toEqual([]);
    expect(errs(['post'], 'client').join('\n')).toContain('post');
    expect(errs(['OPTIONS'], 'client').join('\n')).toContain('OPTIONS');
    expect(errs(['POTS'], 'server').join('\n')).toContain('POTS');
    expect(errs(['*'], 'client').join('\n')).toContain("'*'");
    expect(errs(['*'], 'server')).toEqual([]);
  });

  it('从 insert、update 里取出写进 min_client_version 的字面量（注释不算）', () => {
    expect(literals("insert into public.app_config (id, min_client_version, latest_version, ai) values\n  (1, '4.0.0', '4.0.0', '{\"a\": 1, \"b\": 2}')")).toEqual(['4.0.0']);
    expect(literals("update public.app_config set min_client_version = '4.1.0' where id = 1;")).toEqual(['4.1.0']);
    expect(literals('insert into app_config (id, min_client_version) values (1, null);')).toEqual([]);
    expect(literals("-- update public.app_config set min_client_version = '1234567.0.0'\nselect 1;")).toEqual([]);
  });

  it('块注释不算；$$ 函数体里写 min_client_version 报“取不到字面量”，只读的体不报（K10 复审，偏严）', () => {
    expect(literals("/* update public.app_config set min_client_version = '1234567.0.0'; */ select 1;")).toEqual([]);
    expect(literals("/* 外 /* 嵌套 */ update public.app_config set min_client_version = '9.9.9999999'; */ select 1;")).toEqual([]);
    const write = findings("do $$ begin update public.app_config set min_client_version = '4.1.0'; end $$;");
    expect(write.opaque.length).toBe(1);
    expect(write.literals).toEqual([]);
    expect(findings("create function private.f() returns void language plpgsql as $fn$ begin execute format('update public.app_config set min_client_version = %L', '4.1.0'); end $fn$;").opaque.length).toBe(1);
    expect(findings("do $$ begin if exists (select 1 from public.app_config where min_client_version !~ '^x$') then raise exception 'bad'; end if; end $$;").opaque).toEqual([]);
    expect(findings("do $$ begin update public.todos set title = 'a'; end $$;").opaque).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'lemo-mig-'));
    writeFileSync(join(dir, '9_x.sql'), "do $$ begin update public.app_config set min_client_version = '4.1.0'; end $$;");
    expect(checkMins(dir).join('\n')).toContain('取不到字面量');
  });

  it('真仓库的迁移：0001 写的是 4.0.0，过得了 1～6 位的检查；超长的值会报', () => {
    const dir = resolve(import.meta.dirname, '../../supabase/migrations');
    expect(literals(readFileSync(join(dir, '0001_core.sql'), 'utf8'))).toEqual(['4.0.0']);
    expect(checkMins(dir)).toEqual([]);
    expect(literals("update public.app_config set min_client_version = '1234567.0.0';")).toEqual(['1234567.0.0']);
  });
});

describe('迁移 20261029190000 的 DO 块和 pgTAP 13 里照抄的那份一致（K10-min-db 复审：防两份漂移）', () => {
  it('各取出 do $$ … end $$; 一段，归一化空白后完全一致', () => {
    const root = resolve(import.meta.dirname, '../..');
    const doBlocks = (rel: string) => [...readFileSync(join(root, rel), 'utf8').matchAll(/do \$\$[\s\S]*?end \$\$;/g)]
      .map((m) => m[0].replace(/\s+/g, ' ').trim());
    const mig = doBlocks('supabase/migrations/20261029190000_core_min_client_version_check.sql');
    const tap = doBlocks('supabase/tests/rls/13_min_client_version.test.sql');
    expect(mig.length).toBe(1);
    expect(tap.length).toBe(1);
    expect(tap[0]).toBe(mig[0]);
    expect(mig[0]).toContain(String.raw`!~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'`);
  });
});
