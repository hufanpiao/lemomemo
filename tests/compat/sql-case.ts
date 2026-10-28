// SQL 型契约用例和兼容样例的跑法（B0 集成：后端的 supabase/tests/compat 样例接进契约测试）
// 同一个函数给两处用：
//   - tests/compat/run-compat.ts：CI 里连本地 Supabase（postgres.js），跑基线那一版的 SQL 用例
//   - supabase/tests/offline/run.mjs：没有 Docker 时在 PGlite 上跑，验证“只加列”样例旧版照常、“改列名”样例旧版失败
// 只依赖两个函数（exec 执行多句 SQL、query 取结果行），不 import 数据库驱动

export type SqlExec = (sql: string) => Promise<unknown>;
export type SqlQuery = (sql: string) => Promise<readonly Record<string, unknown>[]>;

export interface SqlCaseInput {
  /** 用例 SQL：返回一行一列 result */
  caseSql: string;
  /** supabase/tests/rls/_helpers.psql 的内容（tests.try_as、tests.seed） */
  helpersSql: string;
  /** 可选：先叠上的兼容样例迁移（supabase/tests/compat/sample_*.psql） */
  sampleSql?: string;
}

/** 在事务里跑一条 SQL 用例，返回 result（'ok' 或错误），最后一定回滚 */
export async function runSqlCase(exec: SqlExec, query: SqlQuery, input: SqlCaseInput): Promise<string> {
  await exec('begin');
  try {
    await exec(input.helpersSql);
    await exec('select tests.seed()');
    if (input.sampleSql) await exec(input.sampleSql);
    const rows = await query(input.caseSql);
    const r = rows[0]?.['result'];
    return typeof r === 'string' ? r : `bad_result ${JSON.stringify(rows[0] ?? null)}`;
  } catch (e) {
    return `error ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await exec('rollback').catch(() => undefined);
  }
}

/** 兼容样例头上写的预期：-- expect-old-client: ok | fail */
export function sampleExpectation(sampleSql: string): 'ok' | 'fail' {
  const m = /^-- expect-old-client: (ok|fail)\s*$/m.exec(sampleSql);
  if (!m) throw new Error('兼容样例缺少 “-- expect-old-client: ok|fail” 一行');
  return m[1] === 'ok' ? 'ok' : 'fail';
}
