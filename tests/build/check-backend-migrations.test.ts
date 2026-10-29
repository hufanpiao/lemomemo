// build/check_backend.py：M1～M6 迁移写法（search_path、0001 的授权与先后、授权和架构 3.3 C 逐行比对、建表开关）
// 从 check-backend.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；共用的 run、sample、where 在 check-backend-harness.ts
import { describe, expect, it } from 'vitest';
import { run, sample, where } from './check-backend-harness.ts';

describe('build/check_backend.py（tests/arch-fixtures/check_backend）', () => {
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
});
