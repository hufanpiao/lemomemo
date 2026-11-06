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

const EXPECT_LINE = /^-- expect-old-client: (ok|fail)(?: ([0-9A-Z]{5}))?\s*$/m;

/** 兼容样例头上写的预期：-- expect-old-client: ok | fail [SQLSTATE] */
export function sampleExpectation(sampleSql: string): 'ok' | 'fail' {
  const m = EXPECT_LINE.exec(sampleSql);
  if (!m) throw new Error('兼容样例缺少 “-- expect-old-client: ok|fail [SQLSTATE]” 一行');
  if (m[1] === 'ok' && m[2]) throw new Error('expect-old-client: ok 后面不能写 SQLSTATE');
  return m[1] === 'ok' ? 'ok' : 'fail';
}

/** fail 后面写的 SQLSTATE（如 42703）；没写返回 null */
export function sampleFailCode(sampleSql: string): string | null {
  const m = EXPECT_LINE.exec(sampleSql);
  return m?.[1] === 'fail' ? (m[2] ?? null) : null;
}

/**
 * 样例结果和预期比（CI 的 run-compat.ts、离线的 supabase/tests/offline/run.mjs 共用）。
 * fail 写了 SQLSTATE 时，SQL 用例里至少一条是这个码失败，而且失败的 SQL 用例全是这个码：
 * 别的原因失败（例：rls 标记没打、helpers 报错，结果是 'error …'）不算符合，免得假通过（11-06 CI 兼容样例复盘）。
 * HTTP 用例（.test.ts）只有通过 / 失败，ok 预期时必须通过；fail 预期写了码时只看 SQL 用例。
 */
export function judgeSample(sampleSql: string, sqlResults: readonly string[], httpOk = true): { same: boolean; why: string } {
  const want = sampleExpectation(sampleSql);
  const code = sampleFailCode(sampleSql);
  const bad = sqlResults.filter((r) => r !== 'ok');
  if (want === 'ok') {
    const same = bad.length === 0 && httpOk;
    return { same, why: same ? '旧版照常' : `预期旧版照常，实际有失败（${bad.map((r) => r.split(' ')[0]).join('，') || 'HTTP 用例'}）` };
  }
  if (!code) {
    const same = bad.length > 0 || !httpOk;
    return { same, why: same ? '旧版失败，符合预期' : '预期旧版失败，实际全部通过' };
  }
  const hit = bad.filter((r) => r.startsWith(`${code} `));
  const same = hit.length > 0 && hit.length === bad.length;
  return { same, why: same ? `旧版写入失败（${code}），符合预期` : `预期旧版因 ${code} 失败，实际 ${bad.length ? bad.map((r) => r.slice(0, 80)).join(' | ') : '全部通过'}` };
}
