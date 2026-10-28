// build/check_backend.py：服务器函数的钥匙范围和迁移写法的静态检查（B0 返工：QA D-01、安全中 1、代码审查中 1）
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；每条规则都有“故意写错”的样例证明拦得住
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, ROOT } from '../arch/fixture-header.ts';

interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

function run(root: string): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_backend.py'), '--root', root, '--json'];
  try {
    const out = execFileSync('python', args, { encoding: 'utf8' });
    return { code: 0, errors: (JSON.parse(out) as { errors: Item[] }).errors };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, errors: (JSON.parse(err.stdout) as { errors: Item[] }).errors };
  }
}

const sample = (name: string) => join(FIXTURES, 'check_backend', name);
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

  it('F3（第 6 节开头、TC-B0-75）：九个函数以外引 objstore、读 R2_FN_*、直接用 aws4fetch；服务器函数读 R2_FILES_* → 错误', () => {
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

  it('M3（TC-B0-68）：改 0001～0007 建表文件来打开开关（列默认值、update）→ 错误；带时间戳的数据迁移可以', () => {
    const { code, errors } = run(sample('m3-features-open'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['M3 supabase/migrations/0001_core.sql:5', 'M3 supabase/migrations/0005_anniv.sql:2']);
    expect(errors[0]?.message).toContain('note');
  });

  it('对照组：合规写法 0 个错误', () => {
    expect(run(sample('ok'))).toEqual({ code: 0, errors: [] });
  });

  it('真仓库：0 个错误', () => {
    expect(run(ROOT)).toEqual({ code: 0, errors: [] });
  });
});
