// build/d1/required-indexes.ts 单测（D1 第 7 节必须有的索引；架构 0.47 第 22 条 T2 的 logs_account_export_idx，普通索引四列）。
// 真库上的反例是 supabase/tests/d1-fixtures/35、36（离线 PGlite 跑）；这里只测比对逻辑，并核对迁移里的写法和白名单原文对得上。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requiredIndexProblems } from '../../build/d1/required-indexes.ts';
import { REQUIRED_INDEXES } from '../../build/d1/whitelist.ts';

const DEF = REQUIRED_INDEXES.logs_account_export_idx?.def ?? '';
const WHY = '0.47 第 22 条 T2：part 取片前查本人 export 发起记录';

describe('D1 必须有的索引', () => {
  it('定义原文一字不差：通过；空白差异不算', () => {
    expect(requiredIndexProblems([{ n: 'logs_account_export_idx', d: DEF }])).toEqual([]);
    expect(requiredIndexProblems([{ n: 'logs_account_export_idx', d: `  ${DEF.replace(/ /g, '  ')}\n` }])).toEqual([]);
  });

  it('缺了、少列、换列序、改成部分索引、改成唯一索引都报', () => {
    expect(requiredIndexProblems([])).toEqual([`缺索引 public.logs_account_export_idx（${WHY}）`]);
    for (const d of [
      DEF.replace('(user_id, act, src, code)', '(user_id, code)'),
      DEF.replace('(user_id, act, src, code)', '(user_id, code, act, src)'),
      "CREATE INDEX logs_account_export_idx ON public.logs USING btree (user_id, code) WHERE ((act = 'export'::text) AND (src = 'account'::text))",
      DEF.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
    ]) {
      expect(d).not.toBe(DEF);
      expect(requiredIndexProblems([{ n: 'logs_account_export_idx', d }])).toEqual([`索引 public.logs_account_export_idx 的定义不对（${WHY}）`]);
    }
  });

  it('迁移 20261031120000 建的就是白名单里这一个（名字、表、列）', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261031120000_core_logs_account_export_idx.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/^create index logs_account_export_idx on public\.logs \(user_id, act, src, code\);$/m);
    expect(DEF).toBe('CREATE INDEX logs_account_export_idx ON public.logs USING btree (user_id, act, src, code)');
  });
});
