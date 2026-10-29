// build/check_backend.py：服务器函数的钥匙范围和迁移写法的静态检查（B0 返工：QA D-01、安全中 1、代码审查中 1）
// 每条规则都有“故意写错”的样例证明拦得住。本文件：F1～F6 基本规则、预览专用函数名单的两个参数、对照组、真仓库。
// 10-30 按主题拆开（W1 超行），同一 describe：
// • check-backend-alias.test.ts：F2、F3、F7 的动态 import、esm.sh、import map / package.json 别名、转义、db.ts 按角色导出
// • check-backend-f7-syntax.test.ts：F7 的 Deno / process / globalThis 白名单、TypeScript 解析器、F4 解析不了、跨函数目录引用
// • check-backend-f7-keys.test.ts：F7 用类型检查器判键类型、this、全局事件、白名单绑节点位置；F2 绝对路径引 db.ts
// • check-backend-migrations.test.ts：M1～M6 迁移写法
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；共用的 run、sample、where 在 check-backend-harness.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';
import { run, sample, SAMPLE_PREVIEW, SLOW_TIMEOUT, where } from './check-backend-harness.ts';

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
      'F2 supabase/functions/_preview/db-probe/scan.ts:2', // S3 第三轮复审：db-probe 导入 withVaultScan 也报（按导出名判断）
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

  it('对照组：合规写法 0 个错误', () => {
    expect(run(sample('ok'))).toEqual({ code: 0, errors: [] });
  });

  it('真仓库：0 个错误', () => {
    expect(run(ROOT)).toEqual({ code: 0, errors: [] });
  }, SLOW_TIMEOUT);   // 真跑 python 扫描整个仓库（supabase/functions 全部源码建类型检查器，另扫 functions/、src/、shared/、迁移），见 SLOW_TIMEOUT
});
