// build/check_backend.py：F2、F3、F7 的动态 import、esm.sh 与百分号编码、import map / deno.json / package.json 别名展开、
// 字符串转义、db.ts 按角色分开导出、大小写不同的相对路径、.tsx/.jsx
// 从 check-backend.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；共用的 run、sample、where 在 check-backend-harness.ts
import { describe, expect, it } from 'vitest';
import { run, sample, where } from './check-backend-harness.ts';

describe('build/check_backend.py（tests/arch-fixtures/check_backend）', () => {
  it('F2、F3（审查中 2）：反引号的动态 import（模板字符串）也认得出来', () => {
    const { code, errors } = run(sample('f3-dyn-backtick'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/anniv-roll/index.ts:2',
      'F3 supabase/functions/push-dispatch/index.ts:2',
      'F7 supabase/functions/anniv-roll/index.ts:2', // B1 接手清单 S3 复审必改：动态 import _shared/db.ts 另报 F7
    ].sort());
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

  it('F7（B1 接手清单 S3）：Deno.env.get / has、process.env[…] 的字面量里写转义（值是 R2_FN_…、FN_VAULT_DB_URL、SUPABASE_DB_URL，名字匹配看不见）→ 错误；不带转义的字面量不报', () => {
    const { code, errors } = run(sample('f7-env-escape'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/push-dispatch/index.ts:2',
      'F7 supabase/functions/push-dispatch/index.ts:3',
      'F7 supabase/functions/push-dispatch/index.ts:4',
      'F7 supabase/functions/todo-remind/index.ts:3',
    ]);
    for (const e of errors) expect(e.message).toContain('不带转义');
  });

  it('F3（B1 接手清单 S3）：esm.sh 的 /*aws4fetch、百分号编码 %61ws4fetch、?deps= 里 + 分隔、v135 路径 → 错误；九个函数里的不报，名字只是带 aws4fetch 字样的别的包（解码后也一样）不报', () => {
    const { code, errors } = run(sample('f3-aws4fetch-encoded'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5].map((n) => `F3 supabase/functions/push-dispatch/index.ts:${n}`));
  });

  it('F2、F3、F7（B1 接手清单 S3）：仓库根 deno.json、supabase/deno.jsonc 的别名，package.json "imports" 的子路径别名（整名、* 通配、条件对象的某一支）展开后照样查；imports 不是对象报 F7；名单里的函数经别名引 db.ts 不报', () => {
    const { code, errors } = run(sample('f3-import-map-upward'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F2 supabase/functions/anniv-roll/index.ts:2',
      'F2 supabase/functions/push-dispatch/index.ts:2',
      'F3 supabase/functions/anniv-roll/index.ts:4',
      'F3 supabase/functions/backup-daily/index.ts:2',
      'F3 supabase/functions/todo-remind/index.ts:2',
      'F7 supabase/functions/note-search/package.json:1',
    ]);
  });

  it('F7（B1 接手清单 S3 返工，审查必改 1）：supabase/functions 下所有字符串、模板片段里的 \\x、\\u、八进制、续行、\\_ 这类转义 → 错误（角色名 fn\\x5fvault、URL_ENV 的值、disabled\\x5fat、SUPABASE_DB_URL 都藏不住）；\\n \\t \\0、反斜杠、引号 \\$ 不报', () => {
    const { code, errors } = run(sample('f7-string-escape'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F7 supabase/functions/_shared/db.ts:3',
      'F7 supabase/functions/ai-embed/index.ts:3',
      ...[1, 2, 3, 4, 5, 6, 7, 11].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`),
    ].sort());
    for (const e of errors.filter((x) => x.line !== 1)) expect(e.message).toContain('不准写转义');
    expect(errors.find((e) => e.line === 1)?.message).toContain('解析不了');
  });

  it('F3（B1 接手清单 S3 返工，审查必改 2）：import map 键里的 * 不是通配——lib*/ 照前缀匹配，lib*/dist/main.js 展开成 aws4fetch → 错误；libx/… 对不上不展开', () => {
    const { code, errors } = run(sample('f3-import-map-star-key'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F3 supabase/functions/push-dispatch/index.ts:2']);
  });

  it('F3（B1 接手清单 S3 返工，审查建议 3）：package.json imports 展开成裸包名后按依赖别名接着展开（#s → signer → npm:aws4fetch，#t 再多一层）→ 错误；九个函数里的不报', () => {
    const { code, errors } = run(sample('f3-package-imports-chain'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F3 supabase/functions/push-dispatch/index.ts:2', 'F3 supabase/functions/todo-remind/index.ts:2']);
  });

  it('F7（B1 接手清单 S3 返工，审查建议 4）：仓库根、supabase/、supabase/functions 下的 deno.json(c) 写 links、patch、workspace → 错误', () => {
    const { code, errors } = run(sample('f7-deno-links'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F7 deno.json:1', 'F7 supabase/deno.jsonc:1', 'F7 supabase/functions/deno.json:1']);
    ['patch', 'workspace', 'links'].forEach((f, i) => expect(errors[i]?.message).toContain(`不准写 ${f}`));
  });

  it('F3、F7（B1 接手清单 S3 返工，审查建议 5）：仓库根 package.json 的 npm: 别名照样展开；file: 这类报 F7，报错注明它也作用于服务器函数；版本号写法不报', () => {
    const { code, errors } = run(sample('f3-root-package'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F3 supabase/functions/push-dispatch/index.ts:2', 'F7 package.json:1']);
    expect(errors.find((e) => e.rule === 'F7')?.message).toContain('Deno 往上找 package.json');
  });

  it('F2、F7（B1 接手清单 S3 复审必改，乙方案）：db.ts 按角色分开导出，F2 按导入的导出名判断——收角色参数的旧 withScan（r1～r6：.source、fromCharCode、join、Object.keys 计算键、拼接、模板拼出 fn_vault）不准导入；改名导入看原名；经 _shared 转手也查；import * as、export *、动态 import 报 F7；默认导入报 F2；名单里的具名导入、type 导入不报', () => {
    const { code, errors } = run(sample('f2-db-exports'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      ...['ai-embed', 'ai-media', 'ai-parse', 'ai-summarize', 'file-check', 'note-search'].map((f) => `F2 supabase/functions/${f}/index.ts:1`),
      'F2 supabase/functions/ai-voice/index.ts:2',
      'F2 supabase/functions/vault-file/index.ts:4',
      'F2 supabase/functions/vault-image/index.ts:2',
      'F7 supabase/functions/account/index.ts:2',
      'F7 supabase/functions/vault-file/index.ts:2',
      'F7 supabase/functions/vault/index.ts:2',
    ].sort());
    for (const f of ['ai-embed', 'ai-media', 'ai-parse', 'ai-summarize', 'file-check', 'note-search']) {
      expect(errors.find((e) => e.file.includes(`/${f}/`))?.message).toContain('不准导入 withScan');
    }
    expect(errors.find((e) => e.file.includes('ai-voice'))?.message).toContain('fn_vault');
    expect(errors.find((e) => e.file.includes('vault-image'))?.message).toContain('vault-helper.ts');
    // 第三轮复审建议：间接用到时报错里给出改法（共用模块按角色拆开）
    expect(errors.find((e) => e.file.includes('vault-image'))?.message).toContain('拆到单独的模块');
    expect(errors.find((e) => e.file.includes('/account/'))?.message).toContain('import * as');
  });

  it('F2（B1 接手清单 S3 第三轮复审建议）：相对路径大小写和文件名不同（../_shared/DB.ts、../_Shared/Db.ts）也认出是 db.ts——名单外的函数报 F2、fn_ai 名单里的函数导入 withVaultUser 报 F2；同样写法导入 withAiUser 不报', () => {
    const { code, errors } = run(sample('f2-case-path'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F2 supabase/functions/ai-voice/index.ts:2', 'F2 supabase/functions/push-dispatch/index.ts:2']);
    expect(errors.find((e) => e.file.includes('ai-voice'))?.message).toContain('fn_vault');
  });

  it('F7（B1 接手清单 S3 复审小改）：supabase/functions 下的 .tsx、.jsx 一律报（JSX 属性里的 HTML 实体 fn&#95;vault 会被解码，名字匹配看不见）', () => {
    const { code, errors } = run(sample('f7-jsx-entity'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F7 supabase/functions/push-dispatch/index.tsx:1', 'F7 supabase/functions/todo-remind/index.jsx:1']);
    for (const e of errors) expect(e.message).toContain('.tsx、.jsx');
  });
});
