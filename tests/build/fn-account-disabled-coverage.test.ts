// 停用账号覆盖核对（TC-B1-10、TC-B1-109；架构第 6 节“带 JWT 的函数一律先过 requireActiveUser … 停用或没有 profile 的返回 account_disabled”，
// 0.29 续第 138 条“cron 按用户处理前用 isUsable”）。
// supabase/functions/ 下每个函数（不含下划线开头的 _shared、_preview）都要在下面的 PLAN 里归一类：
// • jwt：带 JWT（TC-B1-10）。源码里引用了 requireActiveUser；PLAN 写明“管理员停用”“没有 profiles 行”两种账号各由哪个测试文件的哪条用例覆盖，
//   那条用例要真的存在、会跑（describe.skip、ignore 之类跳过的不算），而且用例回调里直接执行的白名单断言的期望值里有 account_disabled
//   （expect(…).toEqual / toStrictEqual / toMatchObject / toBe(…) 的参数；assertEquals、assertStrictEquals、assertObjectMatch、assertMatch 的第 2 个参数）；
// • usable：cron 按用户处理（TC-B1-109 的八个函数）。源码里引用了 isUsable / usableUserIds；PLAN 写明管理员停用 S、冷静期 P 的用例；
// • all-users：TC-B1-109 里“照常清理”的（account-purge、storage-sweep），故意不经 account_usable，源码里不准出现；
// • no-user：不按用户鉴权（匿名 + Turnstile、x-ops-secret 等），源码里不准调 requireActiveUser、isUsable。
// 源码指函数目录下全部 .ts（认 import 别名）。新加函数没进 PLAN、PLAN 里的函数已经不在、config.toml 里声明的函数没有目录，都失败；
// config.toml 里 verify_jwt = true 的函数必须是 jwt。
// 还没有用例的格子写 { todo: '…' }：TC-B1-10 要求“每个带 JWT 的函数都返回 account_disabled”，所以 todo 不是警告，最后一条用例照样失败并列出要补的用例。
// 不 import typescript（否则按 tests/arch/coverage.test.ts 要登记进 SLOW_NODE_TESTS）：注释、字符串、正则字面量交给 ts-scan.ts 的小扫描器。
// 被 PLAN 引用的用例别在断言前 return：“先断言再 if (…) return”的类型收窄只认紧挨着、钉死条件的那几种（expect(r.ok).toBe(true); if (!r.ok) return;
// 等，见 ts-scan.ts 的 guardedReturn）；expect(m).toBeDefined(); if (!m) return; 仍算可能跳过（m 为 null 也能过），写成 toBeTruthy() 或 m === undefined。
// skip( 只看名字，别的对象的 .skip(n) 也算跳过（见 runtimeSkip）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertsLiteral, hasAssertion, references, scan, testCases, tomlFunctions } from './ts-scan.ts';

const ROOT = resolve(import.meta.dirname, '../..');

type JwtScenario = 'admin-disabled' | 'no-profile';
type UsableScenario = 'admin-disabled' | 'pending-deletion';
/** file 相对仓库根目录；title 是用例名里的一段（原文照抄，能唯一认出那条用例） */
type Cover = { file: string; title: string } | { todo: string };
type Entry =
  | { kind: 'jwt'; covers: Record<JwtScenario, Cover> }
  | { kind: 'usable'; covers: Record<UsableScenario, Cover> }
  | { kind: 'all-users'; why: string }
  | { kind: 'no-user'; why: string };
type Plan = ReadonlyMap<string, Entry>;

const SCENARIO_NAME: Record<JwtScenario | UsableScenario, string> = {
  'admin-disabled': '管理员停用（disabled_at 有值）',
  'no-profile': '没有 profiles 行',
  'pending-deletion': '注销冷静期（disabled_reason = deletion）',
};

const PLAN: Plan = new Map<string, Entry>([
  ['account', { kind: 'jwt', covers: {
    'admin-disabled': { file: 'tests/functions/account.test.ts', title: 'TC-B1-103 ②、104 ①：管理员停用的账号调 restore 回 account_disabled' },
    // Docker 起真库才跑（store-it）：真 requireActiveUser，没有 profile 的人调 delete 回 403 account_disabled
    'no-profile': { file: 'supabase/tests/store-it/account-store.it.ts', title: 'TC-B1-10：没有 profiles 行的账号调 account delete 回 403 account_disabled' },
  } }],
  ['invite-admin', { kind: 'jwt', covers: {
    'admin-disabled': { file: 'tests/functions/invite-admin.test.ts', title: 'TC-B1-01：停用的管理员（account_disabled）被拒' },
    // Docker 起真库才跑（store-it，同 account）：真 requireActiveUser + 真 account_usable；单测那条（tests/functions/invite-admin.test.ts 的 TC-B1-10）用的是假鉴权
    'no-profile': { file: 'supabase/tests/store-it/invite-admin-store.it.ts', title: 'TC-B1-10：真 JWT、没有 profiles 行的账号调 invite-admin 回 403 account_disabled' },
  } }],
  ['account-purge', { kind: 'all-users', why: 'TC-B1-109：照常处理到期的冷静期账号，故意不用 account_usable；pg_cron 带 x-cron-secret' }],
  ['invite-signup', { kind: 'no-user', why: '架构第 6 节：匿名 + Turnstile，还没有账号' }],
  ['usage-report', { kind: 'no-user', why: '架构第 6 节：x-ops-secret，只出全站统计' }],
]);

/** 架构第 6 节函数表的鉴权列、TC-B1-109 的函数清单：这些函数一旦建目录，PLAN 里的类别必须是这里写的（以后各批自动对上） */
const ARCH_KIND: Readonly<Record<string, Entry['kind']>> = {
  // 第 6 节鉴权列写 JWT 的
  'invite-admin': 'jwt', 'ai-parse': 'jwt', 'ai-voice': 'jwt', 'file-check': 'jwt', 'note-search': 'jwt', 'push-test': 'jwt',
  'vault': 'jwt', 'vault-image': 'jwt', 'vault-file': 'jwt', 'ai-summarize': 'jwt', 'token-admin': 'jwt', 'account': 'jwt',
  // TC-B1-109 的八个：push-dispatch（B2）、anniv-roll（B5）、ai-classify、claude-intake（B3）、ai-media（B4b-1）、ai-embed（B4b-2）、backup-daily（B7a）、
  // tz-recalc（架构 0.42：x-cron-secret，按用户处理前过 isUsable，同 0.29 续第 138 条④）
  'push-dispatch': 'usable', 'anniv-roll': 'usable', 'ai-classify': 'usable', 'claude-intake': 'usable',
  'ai-media': 'usable', 'ai-embed': 'usable', 'backup-daily': 'usable', 'tz-recalc': 'usable',
  // TC-B1-109：对停用、冷静期账号照常清理
  'account-purge': 'all-users', 'storage-sweep': 'all-users',
  // 不按用户鉴权
  'invite-signup': 'no-user', 'usage-report': 'no-user', 'backup-manifest': 'no-user',
};

type Audit = { errors: string[]; todos: string[]; covered: string[] };

/** 核对 fnDir 下的函数、PLAN、测试文件（file 相对 root）；返回错误、待补用例、已覆盖说明 */
function audit(opts: { fnDir: string; root: string; configToml: string; plan: Plan; archKind?: Readonly<Record<string, Entry['kind']>> }): Audit {
  const { fnDir, root, plan } = opts;
  const archKind = opts.archKind ?? ARCH_KIND;
  const errors: string[] = [];
  const todos: string[] = [];
  const covered: string[] = [];
  const dirs = readdirSync(fnDir)
    .filter((nm) => !nm.startsWith('_') && !nm.startsWith('.'))
    .filter((nm) => statSync(join(fnDir, nm)).isDirectory())
    .sort();
  for (const d of dirs) if (!plan.has(d)) errors.push(`${d}：新函数没进 PLAN（TC-B1-10 / TC-B1-109：先归类，带 JWT 的写上 account_disabled 用例）`);
  for (const name of plan.keys()) if (!dirs.includes(name)) errors.push(`${name}：PLAN 里有，supabase/functions/ 下已经没有这个函数`);
  const inConfig = tomlFunctions(opts.configToml);
  for (const nm of inConfig.keys()) if (!dirs.includes(nm)) errors.push(`${nm}：config.toml 里声明了这个函数，supabase/functions/ 下没有这个目录`);

  for (const name of dirs) {
    const entry = plan.get(name);
    if (!entry) continue;
    const srcs = readdirSync(join(fnDir, name), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(fnDir, name, f), 'utf8'));
    const src = srcs.join('\n');
    const usesRequire = srcs.some((c) => references(c, 'requireActiveUser'));
    const usesUsable = srcs.some((c) => references(c, 'isUsable') || references(c, 'usableUserIds'));
    const want = archKind[name];
    if (want !== undefined && want !== entry.kind) errors.push(`${name}：架构第 6 节 / TC-B1-109 归为 ${want}，PLAN 写的是 ${entry.kind}`);
    if (inConfig.get(name)?.get('verify_jwt') === 'true' && entry.kind !== 'jwt') errors.push(`${name}：config.toml 里 verify_jwt = true，PLAN 却不是 jwt`);
    if (entry.kind === 'jwt' && !usesRequire) errors.push(`${name}：PLAN 标 jwt，源码里没引用 requireActiveUser`);
    if (entry.kind !== 'jwt' && usesRequire) errors.push(`${name}：源码里引用了 requireActiveUser（带 JWT），PLAN 却标 ${entry.kind}`);
    if (entry.kind === 'usable' && !usesUsable) errors.push(`${name}：PLAN 标 usable，源码里没引用 isUsable / usableUserIds`);
    if ((entry.kind === 'all-users' || entry.kind === 'no-user') && usesUsable) errors.push(`${name}：PLAN 标 ${entry.kind}，源码里却引用了 isUsable / usableUserIds`);
    if (entry.kind === 'all-users' && /(['"`])account_usable\1/.test(scan(src).text)) errors.push(`${name}：TC-B1-109 要求故意不用 account_usable，源码里出现了`);
    if (entry.kind === 'all-users' || entry.kind === 'no-user') continue;

    for (const [scenario, cover] of Object.entries(entry.covers) as [JwtScenario | UsableScenario, Cover][]) {
      const label = `${name} · ${SCENARIO_NAME[scenario]}`;
      if ('todo' in cover) { todos.push(`${label}：${cover.todo}`); continue; }
      const path = join(root, cover.file);
      if (!existsSync(path)) { errors.push(`${label}：测试文件 ${cover.file} 不存在`); continue; }
      const all = testCases(readFileSync(path, 'utf8')).filter((t) => t.title.includes(cover.title));
      const hits = all.filter((t) => t.skipped === null);
      if (hits.length === 0 && all.length > 0) { errors.push(`${label}：${cover.file} 的“${cover.title}”不会跑（${all.map((t) => t.skipped).join('；')}）`); continue; }
      if (hits.length === 0) { errors.push(`${label}：${cover.file} 里找不到用例“${cover.title}”`); continue; }
      if (hits.length > 1) { errors.push(`${label}：${cover.file} 里“${cover.title}”对上 ${hits.length} 条用例，写长一点`); continue; }
      const tc = hits[0] as (typeof hits)[number];
      const ok = entry.kind === 'jwt' ? assertsLiteral(tc, 'account_disabled') : hasAssertion(tc);
      if (!ok) errors.push(`${label}：${cover.file} 的“${cover.title}”${entry.kind === 'jwt' ? '断言里没有 account_disabled' : '没有断言'}`);
      else covered.push(`${label}：${cover.file}「${tc.title}」`);
    }
  }
  return { errors, todos, covered };
}

const REAL = () => audit({
  fnDir: join(ROOT, 'supabase/functions'),
  root: ROOT,
  configToml: readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8'),
  plan: PLAN,
});

describe('TC-B1-10 / TC-B1-109：每个函数都归了类，带 JWT 的都有 account_disabled 用例', () => {
  it('真仓库：函数和 PLAN 一一对应、类别和源码一致、写了的用例都在且断言了 account_disabled', () => {
    const r = REAL();
    expect(r.errors).toEqual([]);
    // 现有的两个带 JWT 的函数都至少有一条覆盖，防止 PLAN 被整个写成 todo
    expect(r.covered.some((c) => c.startsWith('account ·'))).toBe(true);
    expect(r.covered.some((c) => c.startsWith('invite-admin ·'))).toBe(true);
  });

  it('PLAN 里没有 todo（TC-B1-10 要求每个带 JWT 的函数都返回 account_disabled：缺用例就失败，列出要补的）', () => {
    const r = REAL();
    expect(r.todos, `要补的用例：\n${r.todos.join('\n')}`).toEqual([]);
  });
});

describe('核对本身会报错（临时目录里的假函数、假测试）', () => {
  const mk = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'lemo-acct-dis-'));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    return root;
  };
  const JWT_SRC = "import { requireActiveUser } from '../_shared/auth.ts';\nDeno.serve(async (req) => { await requireActiveUser(req, admin); return new Response(); });\n";
  const GOOD_TEST = [
    "it('停用：account_disabled', async () => { expect(await r.json()).toEqual({ error: 'account_disabled' }); });",
    "it('没有 profile：account_disabled', async () => { expect(await r.json()).toEqual({ error: 'account_disabled' }); });",
  ].join('\n');
  const jwtEntry = (file = 't/a.test.ts'): Entry => ({ kind: 'jwt', covers: {
    'admin-disabled': { file, title: '停用：' }, 'no-profile': { file, title: '没有 profile：' } } });
  const run = (root: string, plan: Plan, configToml = '') => audit({ fnDir: join(root, 'fns'), root, configToml, plan, archKind: {} });

  it('正例：全部对上时没有错误、没有 todo', () => {
    const root = mk({ 'fns/f/index.ts': JWT_SRC, 'fns/_shared/x.ts': '', 't/a.test.ts': GOOD_TEST });
    expect(run(root, new Map([['f', jwtEntry()]]))).toMatchObject({ errors: [], todos: [] });
  });

  it('新函数没进 PLAN、PLAN 里的函数已不存在：都报', () => {
    const root = mk({ 'fns/f/index.ts': JWT_SRC, 'fns/new-fn/index.ts': JWT_SRC, 't/a.test.ts': GOOD_TEST });
    const errs = run(root, new Map([['f', jwtEntry()], ['gone', { kind: 'no-user', why: 'x' }]])).errors.join('\n');
    expect(errs).toContain('new-fn：新函数没进 PLAN');
    expect(errs).toContain('gone：PLAN 里有，supabase/functions/ 下已经没有');
  });

  it('类别和源码对不上：标 jwt 没调 requireActiveUser；标 no-user 却调了；标 usable 没调 isUsable；all-users 用了 account_usable', () => {
    const root = mk({
      'fns/a/index.ts': '// requireActiveUser(req, admin) 只在注释里\nDeno.serve(() => new Response());\n',
      'fns/b/core.ts': JWT_SRC,
      'fns/c/index.ts': 'Deno.serve(() => new Response());\n',
      'fns/d/index.ts': "await admin.schema('private').rpc('account_usable', { p_user: u });\n",
      't/a.test.ts': GOOD_TEST,
    });
    const errs = run(root, new Map<string, Entry>([
      ['a', jwtEntry()], ['b', { kind: 'no-user', why: 'x' }],
      ['c', { kind: 'usable', covers: { 'admin-disabled': { todo: 'x' }, 'pending-deletion': { todo: 'y' } } }],
      ['d', { kind: 'all-users', why: 'x' }],
    ])).errors.join('\n');
    expect(errs).toContain('a：PLAN 标 jwt，源码里没引用 requireActiveUser');
    expect(errs).toContain('b：源码里引用了 requireActiveUser');
    expect(errs).toContain('c：PLAN 标 usable，源码里没引用 isUsable');
    expect(errs).toContain('d：TC-B1-109 要求故意不用 account_usable');
  });

  it('用例文件不在、用例名找不到、对上多条、断言里没有 account_disabled：都报', () => {
    const root = mk({
      'fns/f1/index.ts': JWT_SRC, 'fns/f2/index.ts': JWT_SRC, 'fns/f3/index.ts': JWT_SRC,
      't/weak.test.ts': [
        "it('停用：只看状态码', async () => { expect(r.status).toBe(403); });",
        "it('没有 profile：A', () => { expect(x).toEqual({ error: 'account_disabled' }); });",
        "it('没有 profile：B', () => { expect(x).toEqual({ error: 'account_disabled' }); });",
      ].join('\n'),
    });
    const errs = run(root, new Map<string, Entry>([
      ['f1', jwtEntry('t/missing.test.ts')],
      ['f2', { kind: 'jwt', covers: { 'admin-disabled': { file: 't/weak.test.ts', title: '查无此名' }, 'no-profile': { file: 't/weak.test.ts', title: '没有 profile：' } } }],
      ['f3', { kind: 'jwt', covers: { 'admin-disabled': { file: 't/weak.test.ts', title: '停用：' }, 'no-profile': { file: 't/weak.test.ts', title: '没有 profile：A' } } }],
    ])).errors.join('\n');
    expect(errs).toContain('f1 · 管理员停用（disabled_at 有值）：测试文件 t/missing.test.ts 不存在');
    expect(errs).toContain('f2 · 管理员停用（disabled_at 有值）：t/weak.test.ts 里找不到用例“查无此名”');
    expect(errs).toContain('f2 · 没有 profiles 行：t/weak.test.ts 里“没有 profile：”对上 2 条用例');
    expect(errs).toContain('f3 · 管理员停用（disabled_at 有值）：t/weak.test.ts 的“停用：”断言里没有 account_disabled');
    expect(errs).not.toContain('f3 · 没有 profiles 行');
  });

  it('todo 进 todos（真仓库那条用例据此失败）；verify_jwt = true 却不是 jwt、架构归类不符：都报', () => {
    const root = mk({ 'fns/f/index.ts': JWT_SRC, 'fns/g/index.ts': 'Deno.serve(() => new Response());\n', 't/a.test.ts': GOOD_TEST });
    const plan = new Map<string, Entry>([
      ['f', { kind: 'jwt', covers: { 'admin-disabled': { file: 't/a.test.ts', title: '停用：' }, 'no-profile': { todo: '补 f 的没有 profile 用例' } } }],
      ['g', { kind: 'no-user', why: 'x' }],
    ]);
    const r = audit({ fnDir: join(root, 'fns'), root, configToml: '[functions.g]\nverify_jwt = true\n', plan, archKind: { f: 'usable' } });
    expect(r.todos).toEqual(['f · 没有 profiles 行：补 f 的没有 profile 用例']);
    expect(r.errors.join('\n')).toContain('g：config.toml 里 verify_jwt = true，PLAN 却不是 jwt');
    expect(r.errors.join('\n')).toContain('f：架构第 6 节 / TC-B1-109 归为 usable，PLAN 写的是 jwt');
  });

  it('all-users、no-user 却引用了 isUsable / usableUserIds（子目录、import 别名也查）：都报；config.toml 声明了没有目录的函数：报', () => {
    const root = mk({
      'fns/p/index.ts': "import { isUsable } from '../_shared/auth.ts';\nif ((await isUsable(admin, u)).ok) purge(u);\n",
      'fns/q/lib/scan.ts': "import { usableUserIds as keep } from '../../_shared/auth.ts';\nconst ids = await keep(admin, all);\n",
      'fns/r/index.ts': "import { requireActiveUser as rau } from '../_shared/auth.ts';\nawait rau(req, admin);\n",
    });
    const errs = run(root, new Map<string, Entry>([
      ['p', { kind: 'all-users', why: 'x' }], ['q', { kind: 'no-user', why: 'x' }], ['r', { kind: 'no-user', why: 'x' }],
    ]), 'functions = { ghost = { verify_jwt = true } }\n').errors.join('\n');
    expect(errs).toContain('p：PLAN 标 all-users，源码里却引用了 isUsable / usableUserIds');
    expect(errs).toContain('q：PLAN 标 no-user，源码里却引用了 isUsable / usableUserIds');
    expect(errs).toContain('r：源码里引用了 requireActiveUser（带 JWT），PLAN 却标 no-user');
    expect(errs).toContain('ghost：config.toml 里声明了这个函数，supabase/functions/ 下没有这个目录');
  });

  it('usable：正例（isUsable、usableUserIds 两种都认）；那一格的用例没有断言、被跳过：报', () => {
    const root = mk({
      'fns/u1/index.ts': "import { isUsable } from '../_shared/auth.ts';\nawait isUsable(admin, u);\n",
      'fns/u2/core.ts': "import { usableUserIds } from '../_shared/auth.ts';\nawait usableUserIds(admin, ids);\n",
      't/u.test.ts': [
        "it('S 停用：不推送', () => { expect(sent).toEqual([]); });",
        "it('P 冷静期：不推送', () => { expect(sent).toEqual([]); });",
        "it('S 只打日志', () => { console.log(sent); });",
        "describe.skip('先不跑', () => { it('P 跳过的', () => { expect(sent).toEqual([]); }); });",
      ].join('\n'),
    });
    const ok = (s: string, p: string) => ({ kind: 'usable' as const, covers: { 'admin-disabled': { file: 't/u.test.ts', title: s }, 'pending-deletion': { file: 't/u.test.ts', title: p } } });
    expect(run(root, new Map<string, Entry>([['u1', ok('S 停用', 'P 冷静期')], ['u2', ok('S 停用', 'P 冷静期')]])).errors).toEqual([]);
    const errs = run(root, new Map<string, Entry>([['u1', ok('S 只打日志', 'P 跳过的')], ['u2', ok('S 停用', 'P 冷静期')]])).errors.join('\n');
    expect(errs).toContain('u1 · 管理员停用（disabled_at 有值）：t/u.test.ts 的“S 只打日志”没有断言');
    expect(errs).toContain('u1 · 注销冷静期（disabled_reason = deletion）：t/u.test.ts 的“P 跳过的”不会跑（包在 describe.skip 里）');
  });
});
