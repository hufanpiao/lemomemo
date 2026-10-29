// build/check_backend.py：服务器函数的钥匙范围和迁移写法的静态检查（B0 返工：QA D-01、安全中 1、代码审查中 1）
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；每条规则都有“故意写错”的样例证明拦得住
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, ROOT } from '../arch/fixture-header.ts';

interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

function run(root: string, extra: string[] = [], env: Record<string, string> = {}): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_backend.py'), '--root', root, '--json', ...extra];
  try {
    const out = execFileSync('python', args, { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, errors: (JSON.parse(out) as { errors: Item[] }).errors };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, errors: (JSON.parse(err.stdout) as { errors: Item[] }).errors };
  }
}

const sample = (name: string) => join(FIXTURES, 'check_backend', name);
/** 真名单已清空（r2-probe 10-28 下线）；F6 的样例按“名单里有 r2-probe”跑，证明名单里的照规则放行、名单外的照样拦 */
const SAMPLE_PREVIEW = ['--sample-preview-funcs', 'r2-probe'];
const where = (errors: Item[]) => errors.map((e) => `${e.rule} ${e.file}:${e.line}`).sort();

describe('build/check_backend.py（tests/arch-fixtures/check_backend）', () => {
  it('F1（TC-B0-35）：supabase/functions 里读 SUPABASE_DB_URL → 错误；注释里提到不算', () => {
    const { code, errors } = run(sample('f1-db-url'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F1 supabase/functions/push-dispatch/index.ts:2']);
  });

  it('F2（6.2、8.4）：名单外的函数直接或间接引到 _shared/db.ts、fn_ai 组用 fn_vault、db.ts 以外的共用模块读连接串 → 错误', () => {
    const { code, errors } = run(sample('f2-db-scope'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/_shared/leak.ts:2',
      'F2 supabase/functions/ai-embed/index.ts:3',
      'F2 supabase/functions/anniv-roll/index.ts:2',
      'F2 supabase/functions/push-dispatch/index.ts:2',
    ]);
    const anniv = errors.find((e) => e.file.includes('anniv-roll'));
    expect(anniv?.message).toContain('_shared/helper.ts');
    expect(errors.find((e) => e.file.includes('ai-embed'))?.message).toContain('fn_vault');
  });

  it('F2、F6（B0 P6 db-probe）：预览专用函数只看 PREVIEW_AI_FUNCS——db-probe 经 db.ts 用 fn_ai、读 FN_AI_DB_URL 不报，用 fn_vault 报；_preview/vault/ 和正式函数同名也拿不到正式名额', () => {
    // 显式带样例参数，不靠真名单（db-probe 下线、真名单清空后这条照样成立）
    const { code, errors } = run(sample('f2-preview-db'), ['--sample-preview-funcs', 'db-probe']);
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/_preview/db-probe/index.ts:4',
      'F2 supabase/functions/_preview/vault/index.ts:1',
      'F2 supabase/functions/_preview/vault/index.ts:2',
      'F6 supabase/functions/_preview/vault/index.ts:1',
    ]);
  });

  it('F3（第 6 节开头、TC-B0-35）：九个函数以外引 objstore、读 R2_FN_*、直接用 aws4fetch；服务器函数读 R2_FILES_* → 错误', () => {
    const { code, errors } = run(sample('f3-objstore-scope'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F3 supabase/functions/backup-daily/index.ts:2',
      'F3 supabase/functions/file-check/index.ts:3',
      'F3 supabase/functions/note-search/index.ts:2',
      'F3 supabase/functions/push-dispatch/index.ts:2',
    ]);
    expect(errors.find((e) => e.file.includes('file-check'))?.message).toContain('R2_FILES_ACCESS_KEY_ID');
  });

  it('F4：Pages Functions 里 /files 以外 import shared/objstore.ts、读 R2_FN_* → 错误', () => {
    const { code, errors } = run(sample('f4-pages-scope'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F4 functions/files/bad-token.ts:2', 'F4 functions/sb/bad.ts:2']);
  });

  it('F5（TC-B0-97 ④）：_shared/auth.ts、account、account-purge 以外出现 disabled_at → 错误；生成目录不算', () => {
    const { code, errors } = run(sample('f5-disabled-at'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F5 supabase/functions/push-dispatch/index.ts:2']);
  });

  it('F6（架构 6.2 末尾预览专用一行，B0 P12）：_preview/ 下不在名单的目录、散放的文件；_shared 和正式函数引 _preview/；顶层同名入口进了仓库 → 错误；r2-probe 本身用 R2 不报', () => {
    const { code, errors } = run(sample('f6-preview-only'), SAMPLE_PREVIEW);
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F3 supabase/functions/r2-probe/index.ts:2', // 顶层同名目录不算预览专用，用 R2 照样越界
      'F6 supabase/functions/_preview/loose.ts:1',
      'F6 supabase/functions/_preview/other-probe/index.ts:1',
      'F6 supabase/functions/_shared/leak.ts:2',
      'F6 supabase/functions/push-dispatch/index.ts:2',
      'F6 supabase/functions/r2-probe/index.ts:1',
      'F6 supabase/functions/r2-probe/index.ts:2',
    ]);
    expect(errors.some((e) => e.file.includes('_preview/r2-probe/'))).toBe(false);
    expect(errors.find((e) => e.file.endsWith('r2-probe/index.ts') && e.line === 1)?.message).toContain('deploy-preview.yml');
  });

  it('F6：真名单为空（r2-probe 已下线）时规则照样有效——_preview/ 下任何目录都报不在名单、也不能用 R2；config.toml 的 entrypoint 照样查', () => {
    const a = run(sample('f6-preview-only'));
    expect(a.code).toBe(1);
    expect(where(a.errors)).toContain('F6 supabase/functions/_preview/r2-probe/index.ts:1');
    expect(where(a.errors)).toContain('F3 supabase/functions/_preview/r2-probe/index.ts:2');
    expect(a.errors.find((e) => e.file.endsWith('_preview/r2-probe/index.ts') && e.line === 1)?.message).toContain('不在预览专用函数的名单里');
    const b = run(sample('f6-config-dotted'));
    expect(where(b.errors)).toEqual(['F6 supabase/config.toml:10', 'F6 supabase/config.toml:12', 'F6 supabase/config.toml:8']);
  });

  it('F6（审查中 2）：supabase/ 下 _preview/ 以外的任何文件（json 配置、迁移注释、源码字符串）提到 _preview → 错误；vault_preview 这类表名不算', () => {
    const { code, errors } = run(sample('f6-preview-mention'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F6 supabase/functions/deno.json:3',
      'F6 supabase/functions/push-dispatch/index.ts:2',
      'F6 supabase/migrations/20261101000000_note.sql:2',
    ]);
  });

  it('F6（审查中 2）：.toml 里声明预览专用函数 [functions.r2-probe]（含带引号、子表的写法）→ 错误；别的函数的声明不算', () => {
    const { code, errors } = run(sample('f6-preview-config'), SAMPLE_PREVIEW);
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F6 supabase/config.toml:2']);
    expect(errors[0]?.message).toContain('[functions.r2-probe]');
  });

  it('F6（第二轮审查低 3）：config.toml 用 tomllib 解析——点号键、转义拼出的键名、entrypoint 指到 supabase/functions/ 以外或 _preview/ 里都查得出', () => {
    const { code, errors } = run(sample('f6-config-dotted'), SAMPLE_PREVIEW);
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F6 supabase/config.toml:10', 'F6 supabase/config.toml:12', 'F6 supabase/config.toml:6', 'F6 supabase/config.toml:8']);
    expect(errors.find((e) => e.line === 6)?.message).toContain('[functions.r2-probe]');
    for (const line of [8, 10, 12]) expect(errors.find((e) => e.line === line)?.message).toContain('entrypoint');
  });

  it('F6（第二轮审查低 3）：根上的内联表 functions = { r2-probe = … } 也算声明', () => {
    const { code, errors } = run(sample('f6-config-inline'), SAMPLE_PREVIEW);
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F6 supabase/config.toml:2']);
    expect(errors[0]?.message).toContain('[functions.r2-probe]');
  });

  it('F2、F3（审查中 2）：反引号的动态 import（模板字符串）也认得出来', () => {
    const { code, errors } = run(sample('f3-dyn-backtick'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F2 supabase/functions/anniv-roll/index.ts:2', 'F3 supabase/functions/push-dispatch/index.ts:2']);
  });

  it('F3（S3，安全第二轮新低 1）：从 esm.sh、jsdelivr、esm.sh 的 alias 参数引 aws4fetch 也算；九个函数里的不报，名字只是带 aws4fetch 字样的别的包不报', () => {
    const { code, errors } = run(sample('f3-esm-aws4fetch'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F3 supabase/functions/note-search/index.ts:2',
      'F3 supabase/functions/note-search/index.ts:3',
      'F3 supabase/functions/push-dispatch/index.ts:2',
    ]);
  });

  it('F2、F3、F7（S3，架构 0.34）：import map 别名（deno.json 的整名、前缀别名、指到 esm.sh；config.toml import_map 指的文件里的 scopes）展开后照样查；map 解析不了报 F7；名单里的函数经别名引 db.ts 不报', () => {
    const { code, errors } = run(sample('f3-import-map'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/anniv-roll/index.ts:2',
      'F3 supabase/functions/backup-daily/index.ts:2',
      'F3 supabase/functions/push-dispatch/index.ts:2',
      'F3 supabase/functions/todo-remind/index.ts:2',
      'F7 supabase/functions/vault-image/deno.json:1',
    ]);
    expect(errors.find((e) => e.rule === 'F7')?.message).toContain('import map');
  });

  it('F7（S3）：Deno.env.get 的名字是拼接、变量、带 ${} 的模板字符串 → 错误；共用模块也不例外（只有 _shared/db.ts 的 URL_ENV[role]）；字面量名字不报', () => {
    const { code, errors } = run(sample('f7-env-concat'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F3 supabase/functions/backup-daily/index.ts:7', // Deno['env'].get('R2_…')：字面量名字 F3 认出
      'F7 supabase/functions/_shared/helper.ts:2',
      'F7 supabase/functions/backup-daily/index.ts:3',
      'F7 supabase/functions/backup-daily/index.ts:5',
      'F7 supabase/functions/backup-daily/index.ts:7', // 方括号取 env 不在 Deno 白名单里（代码审查有条件通过 1）
      'F7 supabase/functions/push-dispatch/index.ts:2',
    ]);
  });

  it('F7（S3）：Deno.env.toObject()、把 Deno.env 存进变量、process.env 整个拿走或用变量下标 → 错误；process.env 写字面量名字不报', () => {
    const { code, errors } = run(sample('f7-env-toobject'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/todo-remind/index.ts:4',
      'F3 supabase/functions/anniv-roll/index.ts:3',
      'F7 supabase/functions/anniv-roll/index.ts:2',
      'F7 supabase/functions/push-dispatch/index.ts:2',
      'F7 supabase/functions/todo-remind/index.ts:3',
      'F7 supabase/functions/todo-remind/index.ts:5',
    ]);
  });

  it('F7（S3）：动态 import 的参数是拼接、变量、带 ${} 的模板字符串 → 错误；字面量（含不带 ${} 的反引号）不报', () => {
    const { code, errors } = run(sample('f7-dyn-import'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/anniv-roll/index.ts:3',
      'F7 supabase/functions/push-dispatch/index.ts:2',
      'F7 supabase/functions/push-dispatch/index.ts:5',
    ]);
  });

  it('F7（代码审查有条件通过 1）：Deno 改成白名单——Deno?.env、解构、globalThis 取 Deno、Reflect.get、拼接下标、标识符转义、存进变量、(globalThis as …)[…]、get 的参数不是纯字面量 → 错误；字面量的 get / has、Deno.serve、字符串和正则里的转义不报', () => {
    const { code, errors } = run(sample('f7-deno-whitelist'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      ...[2, 3, 5, 6, 7, 8, 9, 10, 11].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
      'F7 supabase/functions/todo-remind/index.ts:2',
    ].sort());
    expect(errors.find((e) => e.line === 10)?.message).toContain('只准跟 .标识符');
    expect(errors.find((e) => e.file.includes('todo-remind'))?.message).toContain('转义');
  });

  it('F7（代码审查有条件通过 2）：node:process 具名导入、命名空间导入、export from、动态 import；process?.env、process[…]、解构、存进变量 → 错误；默认导入和 process.env.名字不报', () => {
    const { code, errors } = run(sample('f7-process-import'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    for (const n of [2, 3, 4, 9]) expect(errors.find((e) => e.line === n)?.message).toContain('只准默认导入');
    for (const n of [5, 6, 7, 8]) expect(errors.find((e) => e.line === n)?.message).toContain('process 只准写');
  });

  it('F1～F7（代码审查有条件通过 3）：去注释认得正则字面量——/[//]/、/[/*]/ 后面的代码照样查；真注释（含正则后面的）照样不算', () => {
    const { code, errors } = run(sample('f7-regex-comment'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
  });

  it('F2、F7（代码审查有条件通过 4）：.jsx、.cjs、.cts、.mjs、.mts 也是源码，import 边跟得过去；名单里的函数经 .jsx 引 db.ts 不报', () => {
    const { code, errors } = run(sample('f2-source-ext'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/_shared/x.jsx:2',
      ...['a.jsx', 'b.cjs', 'c.cts', 'd.mjs', 'e.mts'].map((f) => `F2 supabase/functions/push-dispatch/${f}:1`),
      // 第四轮必改 4：supabase/functions 下不准有 .cjs、.cts（另报 F7）
      'F7 supabase/functions/push-dispatch/b.cjs:1',
      'F7 supabase/functions/push-dispatch/c.cts:1',
    ].sort());
  });

  it('F3、F7（代码审查有条件通过 6）：package.json 的 npm: 别名展开后照样查（整名和子路径）；能用 R2 的函数、版本号写法的依赖不报；github: 这类看不出指到哪儿的报 F7', () => {
    const { code, errors } = run(sample('f3-package-alias'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F3 supabase/functions/todo-remind/index.ts:2',
      'F3 supabase/functions/todo-remind/index.ts:3',
      'F7 supabase/functions/push-dispatch/package.json:1',
    ]);
    expect(errors.find((e) => e.rule === 'F7')?.message).toContain('github:');
  });

  it('F7（代码审查第三轮必改 2）：Reflect.get / Object.getOwnPropertyDescriptor 取 globalThis、eval、Function、new Function、require、createRequire 和 node:module、globalThis 存进变量 / ?. / 当参数传、self 和 window、字符串 Deno、白名单外的别名 → 错误；globalThis.标识符、登记过的别名 G 只跟 .标识符、名字里带这些字样的不报', () => {
    const { code, errors } = run(sample('f7-global-escape'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/_shared/gen/objstore-net.ts:5',
      'F7 supabase/functions/_shared/other.ts:2',
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
      'F7 supabase/functions/push-dispatch/mod.ts:2',
      'F7 supabase/functions/push-dispatch/mod.ts:3',
      'F7 supabase/functions/push-dispatch/req.cjs:1', // 第四轮：.cjs 文件本身不准有
      'F7 supabase/functions/push-dispatch/req.cjs:2',
    ].sort());
    const msg = (file: string, line: number) => errors.find((e) => e.file.endsWith(file) && e.line === line)?.message ?? '';
    expect(msg('push-dispatch/index.ts', 2)).toContain('Reflect.get');
    expect(msg('push-dispatch/index.ts', 3)).toContain('Object.getOwnPropertyDescriptor');
    expect(msg('push-dispatch/index.ts', 4)).toContain('eval');
    expect(msg('push-dispatch/index.ts', 5)).toContain('Function');
    expect(msg('push-dispatch/req.cjs', 2)).toContain('require');
    expect(msg('push-dispatch/index.ts', 11)).toContain("'Deno'");
  });

  it('F2、F7（代码审查第三轮必改 1，b5～b7、b11～b14）：改用 TypeScript 解析器——) 后面的正则、除号后面的 /* 和反引号藏不住代码；.d.mts、带第二个参数的动态 import 照样跟；拆行拼接的动态 import、标识符转义报；除号后面的普通注释不误报', () => {
    const { code, errors } = run(sample('f7-parser-cases'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/push-dispatch/b11.d.mts:2',
      'F2 supabase/functions/push-dispatch/index.ts:7',
      ...[2, 3, 5, 8, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
    ].sort());
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
    expect(errors.find((e) => e.rule === 'F7' && e.line === 10)?.message).toContain('转义');
  });

  it('F7（代码审查第四轮必改 1～4）：constructor、__proto__、getPrototypeOf、字符串 constructor、拼出来的方括号属性名、变量下标马上调用、Worker、SharedWorker、data: / blob: 地址、.cjs、.cts → 错误；数字下标运算、字面量下标调用、类的 constructor 声明不报', () => {
    const { code, errors } = run(sample('f7-proto-worker'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/push-dispatch/data.ts:2',
      'F7 supabase/functions/push-dispatch/data.ts:3',
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
      'F7 supabase/functions/push-dispatch/legacy.cjs:1',
      'F7 supabase/functions/push-dispatch/legacy.cts:1',
    ].sort());
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
    const msg = (file: string, line: number) => errors.find((e) => e.file.endsWith(file) && e.line === line)?.message ?? '';
    expect(msg('index.ts', 2)).toContain('constructor');
    expect(msg('index.ts', 6)).toContain('类型是 string');
    expect(msg('index.ts', 7)).toContain('拼出来');
    expect(msg('index.ts', 9)).toContain('Worker');
    expect(msg('data.ts', 2)).toContain('data:');
    expect(msg('legacy.cjs', 1)).toContain('.cjs');
  });

  it('F4（代码审查第四轮低 1）：Pages、App、shared 里解析不了的源码报错，不当成 0 个问题', () => {
    const { code, errors } = run(sample('f4-parse-error'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F4 functions/sb/broken.ts:1']);
    expect(errors[0]?.message).toContain('解析不了');
  });

  it('F1、F4（K2 安全审查，架构 8.4、0.38 第 24 条）：SIGNUP_HASH_SECRET 只准 invite-signup、account-purge 读——account、共用模块、同名预览专用函数读了报 F1，Pages 里出现报 F4；名单里的两个函数、注释里提到不报', () => {
    const { code, errors } = run(sample('f1-signup-secret'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F1 supabase/functions/_preview/invite-signup/index.ts:2',
      'F1 supabase/functions/_shared/signup.ts:2',
      'F1 supabase/functions/account/index.ts:2',
      'F4 functions/sb/leak.ts:2',
      'F6 supabase/functions/_preview/invite-signup/index.ts:1', // 不在预览名单里
    ]);
    expect(errors.find((e) => e.file.endsWith('account/index.ts'))?.message).toContain('account-purge、invite-signup');
    expect(errors.some((e) => e.file.includes('/invite-signup/') && !e.file.includes('_preview') || e.file.includes('account-purge'))).toBe(false);
  });

  it('F7（代码审查第五轮必改 1）：不准 import 别的函数目录里的文件（借别的函数绕开只准某几个函数读的名单）；引 _shared/、本函数目录不报', () => {
    const { code, errors } = run(sample('f7-cross-fn'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F7 supabase/functions/push-dispatch/index.ts:2']);
    expect(errors[0]?.message).toContain('别的函数目录');
  });

  it('F7（代码审查第五轮必改 2、3）：不准引 node:vm、node:child_process、node:worker_threads（经别名展开后也查）；node:crypto、npm 包不报', () => {
    const { code, errors } = run(sample('f7-runtime-modules'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.find((e) => e.line === 2)?.message).toContain('node:vm');
    expect(errors.find((e) => e.line === 4)?.message).toContain('worker_threads');
  });

  it('F7（代码审查第五轮，剩余风险①选项乙）：用类型检查器判键类型——方括号、解构计算键的类型是 string（拼出来的、string 变量）→ 错误；number 键、字面量联合键、字面量键不报', () => {
    const { code, errors } = run(sample('f7-key-type'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([4, 6, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
    expect(errors.find((e) => e.line === 4)?.message).toContain('string');
    expect(errors.find((e) => e.line === 9)?.message).toContain('解构的计算键');
  });

  it('F7（代码审查第六轮必改 1）：断言出来的键类型——x as \'length\'、<\'name\'>x、as unknown as number、赋值里藏断言、字面量类型的参数都报；字面量常量、条件表达式、for…of 字面量数组、断言包着的字面量、for 下标和 .length 算术不报', () => {
    const { code, errors } = run(sample('f7-key-assert'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 5, 7, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(3)).toContain('追不到字面量');
    // 第七轮起 number 键只放行字面量、for 下标、.length 算术，断言出来的数字落在这条
    expect(msg(5)).toContain('键的类型是 number');
    expect(msg(7)).toContain('键的类型是 number');
    expect(msg(10)).toContain('追不到字面量');
  });

  it('F7（代码审查第六轮必改 2）：枚举成员当键（字符串枚举、数字枚举）一律报；const 字面量常量不报', () => {
    const { code, errors } = run(sample('f7-key-enum'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 5].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('枚举'))).toBe(true);
  });

  it('F7（代码审查第六轮必改 3）：Reflect.get / has、Object.getOwnPropertyDescriptor 的键走同一条规则；getOwnPropertyDescriptors 禁用；Reflect 存变量、解构，方法存变量，apply / construct 的动态函数，globalThis.Reflect，…展开都报；字面量键、静态函数、Object.keys、类型位置不报', () => {
    const { code, errors } = run(sample('f7-key-reflect'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(3)).toContain('Reflect.get 的键参数');
    expect(msg(6)).toContain('getOwnPropertyDescriptors');
    expect(msg(7)).toContain('Reflect 只准直接调用');
    expect(msg(11)).toContain('Reflect.apply');
    expect(msg(13)).toContain('Reflect.get 的键参数');
  });

  it('F7（代码审查第六轮必改 4 → 第七轮必改 3）：白名单不再按声明文本放行——第六轮能放行的同文本、同声明写法，第七轮按节点位置对不上，照报', () => {
    const { code, errors } = run(sample('f7-key-whitelist'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      ...[2, 3, 5, 6, 7, 9].map((n) => `F7 supabase/functions/account/core.ts:${n}`),
      'F7 supabase/functions/todo-remind/index.ts:3',
    ].sort());
  });

  it('F7（代码审查第七轮必改 1）：普通函数、对象字面量方法里的 this 报；Object.values / keys / entries / assign 的参数是 any / unknown 报；类里的 this、模块顶层 this、参数类型具体的不报', () => {
    const { code, errors } = run(sample('f7-this-enum'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 7, 8, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(2)).toContain('this');
    expect(msg(4)).toContain('对象字面量的方法');
    expect(msg(7)).toContain('Object.values');
    expect(msg(10)).toContain('Object.assign');
  });

  it('F7（代码审查第七轮必改 2）：number 键只放行数字字面量、const 数字常量、for 循环下标、.length 的算术；JSON.parse、参数、调用返回值、let 变量都报', () => {
    const { code, errors } = run(sample('f7-key-number'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([4, 5, 7, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    expect(errors.every((e) => e.message.includes('键的类型是 number'))).toBe(true);
  });

  it('F7（代码审查第七轮必改 3）：白名单绑节点位置——和真仓库登记处同文本、同参数声明但位置不同的照报；Object.hasOwn 守卫写对（同一对象、同一个键、对象不是 any、取值在条件成立那一支）才放行', () => {
    const { code, errors } = run(sample('f7-key-hasown'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6].map((n) => `F7 supabase/functions/account/core.ts:${n}`));
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
  });

  it('F7（代码审查第八轮必改 ①）：不带对象前缀的 addEventListener / dispatchEvent / removeEventListener、globalThis / self 上的都报；具体对象上的、类里同名方法声明不报', () => {
    const { code, errors } = run(sample('f7-event-global'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.find((e) => e.line === 2)?.message).toContain('全局的 addEventListener');
    expect(errors.find((e) => e.line === 6)?.message).toContain('全局的 dispatchEvent');
  });

  it('F7（代码审查第八轮低）：全局事件属性 onunhandledrejection、onerror、onload、onbeforeunload、onunload——不带前缀、globalThis / self 上的赋值和读取都报；具体对象上的、同名局部变量 / 参数 / 对象属性不报', () => {
    const { code, errors } = run(sample('f7-event-props'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('全局事件属性'))).toBe(true);
  });

  it('F7（审查员第九轮低 1）：简写属性 { onunhandledrejection }、{ addEventListener }、{ Reflect } 把全局的东西当值带走，照报；同名的本地变量、参数不报', () => {
    const { code, errors } = run(sample('f7-shorthand'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
  });

  it('F7（代码审查第十轮）：本地 import 有百分号编码、查询串或锚点报 F7，解码 / 去掉后照样查 F2、F3（第十二轮）；解析后落在 supabase/functions 外面的本地 import 报 F7；没有百分号、落在里面的不报', () => {
    const { code, errors } = run(sample('f7-import-local'));
    expect(code).toBe(1);
    const f = 'supabase/functions/push-dispatch/index.ts';
    expect(where(errors)).toEqual([
      `F2 ${f}:2`, `F7 ${f}:2`, `F2 ${f}:3`, `F7 ${f}:3`, `F3 ${f}:4`, `F7 ${f}:4`, `F7 ${f}:5`, `F7 ${f}:6`,
      `F2 ${f}:7`, `F7 ${f}:7`, `F3 ${f}:8`, `F7 ${f}:8`,
    ].sort());
    const f7 = (line: number) => errors.find((e) => e.rule === 'F7' && e.line === line)?.message ?? '';
    expect(f7(2)).toContain('百分号');
    expect(f7(5)).toContain('supabase/functions 外面');
    expect(f7(6)).toContain('supabase/functions 外面');
    expect(f7(7)).toContain('查询串或锚点');
    expect(f7(8)).toContain('查询串或锚点');
  });

  it('F2（B1 接手清单 C10）：不在名单里的函数用绝对路径、盘符路径、file: 地址、指到绝对路径的 import map 别名引 db.ts → 错误；名单里的函数、引别的共用模块不报', () => {
    const { code, errors } = run(sample('f2-abs-path'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5].map((n) => `F2 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('_shared/db.ts'))).toBe(true);
  });

  it('F7（代码审查第八轮必改 ②）：Object.values / entries / assign 的参数、对象展开 { ...x } 的类型是 EventTarget、{}、object 报；类型具体的、对象字面量、条件展开字面量不报', () => {
    const { code, errors } = run(sample('f7-spread-vague'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([5, 6, 7, 8, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.find((e) => e.line === 8)?.message).toContain('对象展开');
  });

  it('F7（代码审查第八轮，白名单改稳）：登记处前面加代码不误报；把同样的签名和取值复制进别的函数名，对不上照报', () => {
    // 用真仓库的 _shared/db.ts（URL_ENV[role] 登记在白名单里，绑的是 connect 函数和它的 role 参数）
    const src = readFileSync(join(ROOT, 'supabase', 'functions', '_shared', 'db.ts'), 'utf8');
    const keyErrors = (content: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'check-backend-wl-'));
      try {
        mkdirSync(join(dir, 'supabase', 'functions', '_shared'), { recursive: true });
        writeFileSync(join(dir, 'supabase', 'functions', '_shared', 'db.ts'), content);
        return run(dir).errors.filter((e) => e.file.endsWith('_shared/db.ts') && e.message.includes('方括号里的属性名'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(src).toContain('function connect(role: FnRole)');
    expect(keyErrors(src)).toEqual([]);
    // 文件开头、connect 函数体开头都加几行代码：位置按“函数链 + 第几处”算，不受影响
    const padded = 'export const padA = 1;\n' + src.replace('function connect(role: FnRole) {', 'function connect(role: FnRole) {\n  const padB = 2; void padB;');
    expect(keyErrors(padded)).toEqual([]);
    // 换个函数名：函数链对不上，两处 URL_ENV[role] 都报
    expect(keyErrors(src.replace(/\bconnect\b/g, 'connect2')).length).toBe(2);
  });

  it('F7（代码审查第六轮低 5）：类型检查器建不起来时每个 F7 文件报一条；取键类型抛异常时报错，都不放行', () => {
    const p = run(sample('f7-key-assert'), [], { CHECK_BACKEND_FAIL_PROGRAM: '1' });
    expect(p.code).toBe(1);
    expect(where(p.errors)).toEqual(['push-dispatch', 'todo-remind'].map((f) => `F7 supabase/functions/${f}/index.ts:1`));
    expect(p.errors.every((e) => e.message.includes('类型检查器建不起来'))).toBe(true);
    const t = run(sample('f7-key-assert'), [], { CHECK_BACKEND_FAIL_TYPE: '1' });
    expect(t.code).toBe(1);
    // 对照组（todo-remind）平时 0 错误，取类型出错时它的非字面量键也全报
    expect(t.errors.filter((e) => e.file.includes('todo-remind')).length).toBeGreaterThan(0);
    expect(t.errors.every((e) => e.message.includes('取键的类型时出错'))).toBe(true);
  });

  it('--print-preview-funcs：一行一个打印预览专用函数名单（deploy-preview.yml、publish.ps1 读这一份）；和脚本里 PREVIEW_FUNCS 一致（10-29 起是 db-probe）', () => {
    const out = execFileSync('python', ['-I', join(ROOT, 'build', 'check_backend.py'), '--print-preview-funcs'], { encoding: 'utf8' });
    // 名单只写在 check_backend.py 一处：从源码里读出 PREVIEW_FUNCS 再比，增删预览专用函数时这条不用跟着改
    const src = readFileSync(join(ROOT, 'build', 'check_backend.py'), 'utf8');
    const decl = /^PREVIEW_FUNCS = frozenset\((.*)\)$/m.exec(src)?.[1] ?? '';
    const want = [...decl.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(out.split(/\r?\n/).filter(Boolean).sort()).toEqual(want);
  });

  it('--sample-preview-funcs 只给样例用：不能和 --print-preview-funcs 一起用（读出的名单只能是真名单）', () => {
    let status = 0;
    try {
      execFileSync('python', ['-I', join(ROOT, 'build', 'check_backend.py'), '--print-preview-funcs', '--sample-preview-funcs', 'evil'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });

  it("M1（TC-B0-92 续第 117 条）：security definer 函数没写 set search_path = '' → 错误（含 QA 复现原句、写在函数体后面的）", () => {
    const { code, errors } = run(sample('m1-definer-search-path'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'M1 supabase/migrations/20261028000000_bad.sql:11',
      'M1 supabase/migrations/20261028000000_bad.sql:2',
      'M1 supabase/migrations/20261028000000_bad.sql:6',
    ]);
    expect(errors.find((e) => e.line === 2)?.message).toContain('private.qa_probe_definer');
  });

  it('M2（TC-B0-73 ①②）：0001 第一句不对、grant 挪到别的文件、grant 和建函数中间隔了别的语句、0001 以外整段 revoke → 错误；新建函数不写 grant 不报（④ 由默认权限兜底）', () => {
    const { code, errors } = run(sample('m2-grant-placement'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'M2 supabase/migrations/0001_core.sql:2',
      'M2 supabase/migrations/0001_core.sql:5',
      'M2 supabase/migrations/0003_notes.sql:2',
      'M2 supabase/migrations/0004_attachments.sql:9',
    ]);
    expect(errors.find((e) => e.line === 9)?.message).toContain('紧跟');
  });

  it('M4（TC-B0-73 ①，架构 3.3 C 0.33 写法）：迁移的授权和 3.3 C 逐行比对、核对行尾标的文件，附录 A 末尾和 3.3 C 一字不差', () => {
    const { code, errors } = run(sample('m4-grant-summary'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'M4 docs/10-架构/架构设计-v4.md:12', // 标 0004 的一句 0004 里没有（写进了 0001）
      'M4 docs/10-架构/架构设计-v4.md:13', // 标 0001 的一句 0001 里没有
      'M4 docs/10-架构/架构设计-v4.md:14', // 行尾没标文件
      'M4 docs/10-架构/架构设计-v4.md:25', // 附录 A 和 3.3 C 不一样
      'M4 supabase/migrations/0001_core.sql:7', // 标 0004，写在 0001
      'M4 supabase/migrations/0001_core.sql:9', // 3.3 C 里没有
      'M4 supabase/migrations/20261101000000_b1.sql:5', // 标 0001 的写进了新迁移
    ]);
    expect(errors.find((e) => e.file.endsWith('0001_core.sql') && e.line === 7)?.message).toContain('0004');
  });

  it('M5、M6（TC-B0-73 ③⑤）：0001 的先后、同步表建表后紧跟 table_meta 行、(user_id, synced_at) 索引写在建表的文件里', () => {
    const { code, errors } = run(sample('m5-migration-order'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'M5 supabase/migrations/0001_core.sql:11',
      'M5 supabase/migrations/0001_core.sql:4',
      'M5 supabase/migrations/0001_core.sql:7',
      'M5 supabase/migrations/0001_core.sql:9',
      'M5 supabase/migrations/0003_notes.sql:4',
      'M6 supabase/migrations/0002_calendar_todos.sql:2',
    ]);
    expect(errors.find((e) => e.rule === 'M6')?.message).toContain('0003_notes.sql:2');
  });

  it('M3（TC-B0-68、QA 第二轮 D-15、代码第三轮新低 1）：改 0001～0007 建表文件来打开开关（列默认值、update、alter column features set default）→ 错误；同一句里每个 set default 都查、注释和字符串里的不算；带时间戳的数据迁移可以', () => {
    const { code, errors } = run(sample('m3-features-open'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'M3 supabase/migrations/0001_core.sql:5',
      'M3 supabase/migrations/0005_anniv.sql:14', // 注释里先写了一处 on: false，第二个子句才打开 note
      'M3 supabase/migrations/0005_anniv.sql:2',
      'M3 supabase/migrations/0005_anniv.sql:4',
      'M3 supabase/migrations/0005_anniv.sql:7',
    ]);
    expect(errors[0]?.message).toContain('note');
    expect(errors[2]?.message).toContain('note');
    expect(errors[3]?.message).toContain('JSON 字面量');
  });

  it('对照组：合规写法 0 个错误', () => {
    expect(run(sample('ok'))).toEqual({ code: 0, errors: [] });
  });

  it('真仓库：0 个错误', () => {
    expect(run(ROOT)).toEqual({ code: 0, errors: [] });
  });
});
