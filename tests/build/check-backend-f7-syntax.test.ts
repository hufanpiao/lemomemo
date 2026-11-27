// build/check_backend.py：F7 的语法层检查——Deno、node:process、globalThis、Reflect 白名单，TypeScript 解析器，
// 正则字面量去注释、各种源码扩展名、F4 解析不了报错、SIGNUP_HASH_SECRET、跨函数目录引用、禁用的 node 模块
// 从 check-backend.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；共用的 run、sample、where 在 check-backend-harness.ts
import { describe, expect, it } from 'vitest';
import { run, sample, where } from './check-backend-harness.ts';

describe('build/check_backend.py（tests/arch-fixtures/check_backend）', () => {
  it('F7（代码审查有条件通过 1）：Deno 改成白名单——Deno?.env、解构、globalThis 取 Deno、Reflect.get、拼接下标、标识符转义、存进变量、(globalThis as …)[…]、get 的参数不是纯字面量 → 错误；字面量的 get / has、Deno.serve、不带参数的 Deno.memoryUsage()、正则里的转义、字符串里的 \\t 不报', () => {
    const { code, errors } = run(sample('f7-deno-whitelist'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      // 13、14：Deno.memoryUsage 不调用、带参数都拒；12 行直接调用不带参数放行（架构 0.47 第 21 条导出内存探针）
      ...[2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 14].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
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

  it('F2、F7（代码审查有条件通过 4）：.jsx、.cjs、.cts、.mjs、.mts 也是源码，import 边跟得过去；名单里的函数经 .jsx 引 db.ts 不报 F2（但 .jsx、.tsx 文件本身从 S3 复审起报 F7）', () => {
    const { code, errors } = run(sample('f2-source-ext'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/_shared/x.jsx:2',
      ...['a.jsx', 'b.cjs', 'c.cts', 'd.mjs', 'e.mts'].map((f) => `F2 supabase/functions/push-dispatch/${f}:1`),
      // 第四轮必改 4：supabase/functions 下不准有 .cjs、.cts（另报 F7）
      'F7 supabase/functions/push-dispatch/b.cjs:1',
      'F7 supabase/functions/push-dispatch/c.cts:1',
      // B1 接手清单 S3 复审小改：supabase/functions 下不准有 .tsx、.jsx（另报 F7）
      'F7 supabase/functions/_shared/x.jsx:1',
      'F7 supabase/functions/push-dispatch/a.jsx:1',
      'F7 supabase/functions/vault/h.jsx:1',
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
      // 第 7 行：B1 接手清单 S3 复审必改起，动态 import _shared/db.ts 另报 F7
      ...[2, 3, 5, 7, 8, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
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
});
