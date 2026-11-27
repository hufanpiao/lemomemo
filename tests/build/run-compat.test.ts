// 旧版契约测试机制的单测（TC-B0-57 的机制部分；真正对本地 Supabase 跑一遍待 Docker）
// 原 tests/compat/run-compat.test.ts（前端 B），B0 集成时挪到 tests/build：tests/compat/ 只放契约用例和框架
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingSupabaseEnv, parseArgs } from '../compat/run-compat.ts';
import { judgeSample, runSqlCase, sampleExpectation, sampleFailCode } from '../compat/sql-case.ts';
import { parseSubset, sqlCases, testFiles } from '../compat/subset.ts';

const root = join(import.meta.dirname, '..', '..');
const compatDir = join(root, 'tests', 'compat');
const repoSubset = parseSubset(readFileSync(join(compatDir, 'subset.json'), 'utf8'));

describe('subset.json', () => {
  it('仓库里的名单合法，文件都在', () => {
    expect(repoSubset.cases.length).toBeGreaterThan(0);
    for (const c of repoSubset.cases) expect(existsSync(join(root, c.file)), c.file).toBe(true);
  });

  it('.test.ts 用例的 id 都在文件里用 contract() 登记了', () => {
    for (const c of repoSubset.cases.filter((x) => x.file.endsWith('.test.ts'))) {
      expect(readFileSync(join(root, c.file), 'utf8')).toContain(`contract('${c.id}'`);
    }
  });

  it('拒绝坏路径、坏 id、重复 id、旧格式', () => {
    const one = (c: object) => JSON.stringify({ version: 1, cases: [c] });
    for (const file of ['/etc/passwd', 'tests/compat/../x.test.ts', 'src/a.test.ts', 'tests/compat/a.ts', 'tests/other/a.test.ts']) {
      expect(() => parseSubset(one({ id: 'a', file }))).toThrow();
    }
    expect(() => parseSubset(one({ id: 'A b', file: 'tests/compat/a.test.ts' }))).toThrow();
    const dup = { id: 'a', file: 'tests/compat/a.test.ts' };
    expect(() => parseSubset(JSON.stringify({ version: 1, cases: [dup, dup] }))).toThrow('重复');
    expect(() => parseSubset('{"version":1,"files":[]}')).toThrow();
    expect(() => parseSubset('{"version":2,"cases":[]}')).toThrow();
  });

  it('按类型分开：Vitest 文件去重，SQL 用例单列', () => {
    const s = parseSubset({
      version: 1,
      cases: [
        { id: 'a', file: 'tests/compat/a.test.ts' },
        { id: 'b', file: 'tests/compat/a.test.ts' },
        { id: 'c', file: 'tests/compat/sql/c.sql' },
      ],
    });
    expect(testFiles(s)).toEqual(['tests/compat/a.test.ts']);
    expect(sqlCases(s).map((c) => c.id)).toEqual(['c']);
  });
});

describe('契约用例不引用 tests/compat 以外的代码（基线会被单独取出来跑）', () => {
  const allowed = /^(\.\/(harness|subset|sql-case)\.ts|\.\/subset\.json|vitest|vitest\/config|node:[a-z_/]+|@supabase\/supabase-js|postgres)$/;
  const files = readdirSync(compatDir).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    it(f, () => {
      const text = readFileSync(join(compatDir, f), 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const spec = m[1] ?? '';
        expect(allowed.test(spec), `${f} 引用了 ${spec}`).toBe(true);
      }
    });
  }
});

describe('run-compat 参数', () => {
  it('目录和 --sample', () => {
    expect(parseArgs([])).toEqual({ dir: null, sample: null });
    expect(parseArgs(['/tmp/base/tests/compat', '--sample', 'x.sql'])).toEqual({ dir: '/tmp/base/tests/compat', sample: 'x.sql' });
    expect(() => parseArgs(['--mode', 'report'])).toThrow();
    expect(() => parseArgs(['a', 'b'])).toThrow();
    expect(() => parseArgs(['--sample'])).toThrow();
  });

  it('有 .test.ts 用例却没给本地 Supabase 地址：报缺哪个（否则用例全被跳过、看起来像通过）', () => {
    expect(missingSupabaseEnv({})).toEqual(['API_URL', 'ANON_KEY']);
    expect(missingSupabaseEnv({ API_URL: 'http://127.0.0.1:54321' })).toEqual(['ANON_KEY']);
    expect(missingSupabaseEnv({ API_URL: 'u', ANON_KEY: 'k' })).toEqual([]);
    expect(missingSupabaseEnv({ LEMO_TEST_SUPABASE_URL: 'u', LEMO_TEST_ANON_KEY: 'k' })).toEqual([]);
  });
});

describe('SQL 用例', () => {
  it('后端的兼容样例都写了预期', () => {
    const dir = join(root, 'supabase', 'tests', 'compat');
    const got = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith('.psql'))
        .map((f) => [f, sampleExpectation(readFileSync(join(dir, f), 'utf8'))]),
    );
    expect(got).toEqual({ 'sample_add_column.psql': 'ok', 'sample_rename_column.psql': 'fail' });
    expect(() => sampleExpectation('select 1')).toThrow();
  });

  it('runSqlCase：按顺序 begin → 辅助 → seed → 样例 → 用例，最后一定回滚', async () => {
    const log: string[] = [];
    const exec = async (s: string) => {
      log.push(s);
    };
    const query = async () => [{ result: 'ok' }];
    const r = await runSqlCase(exec, query, { caseSql: 'CASE', helpersSql: 'HELPERS', sampleSql: 'SAMPLE' });
    expect(r).toBe('ok');
    expect(log).toEqual(['begin', 'HELPERS', 'select tests.seed()', 'SAMPLE', 'rollback']);
  });

  it('runSqlCase：出错也回滚，返回错误文字', async () => {
    const log: string[] = [];
    const exec = async (s: string) => {
      log.push(s);
      if (s === 'HELPERS') throw new Error('boom');
    };
    const r = await runSqlCase(exec, async () => [], { caseSql: 'CASE', helpersSql: 'HELPERS' });
    expect(r).toBe('error boom');
    expect(log.at(-1)).toBe('rollback');
  });
});

describe('兼容样例的判定（judgeSample；11-06 CI 兼容样例复盘：db reset 冲掉 rls 标记，“改列名”样例因标记报错也算符合，假通过）', () => {
  const OK = '-- expect-old-client: ok\nselect 1;';
  const FAIL = '-- expect-old-client: fail\nselect 1;';
  const FAIL_CODE = '-- expect-old-client: fail 42703\nselect 1;';
  const MARK = 'error rls 测试只许打 CI、lemo-e2e 或离线库（这个库没有 lemo.test_target 标记）';
  it('仓库里“改列名”样例写明因 42703 失败', () => {
    expect(sampleFailCode(readFileSync(join(root, 'supabase', 'tests', 'compat', 'sample_rename_column.psql'), 'utf8'))).toBe('42703');
    expect(sampleFailCode(readFileSync(join(root, 'supabase', 'tests', 'compat', 'sample_add_column.psql'), 'utf8'))).toBeNull();
  });
  it('ok：SQL 用例全过、HTTP 用例也过才符合；标记报错不符合', () => {
    expect(judgeSample(OK, ['ok']).same).toBe(true);
    expect(judgeSample(OK, [MARK]).same).toBe(false);
    expect(judgeSample(OK, ['ok'], false).same).toBe(false);
  });
  it('fail 写了码：要因为这个码失败；标记报错、别的码、全过都不符合', () => {
    expect(judgeSample(FAIL_CODE, ['42703 column "important" of relation "todos" does not exist']).same).toBe(true);
    expect(judgeSample(FAIL_CODE, [MARK]).same).toBe(false);
    expect(judgeSample(FAIL_CODE, ['42501 permission denied']).same).toBe(false);
    expect(judgeSample(FAIL_CODE, ['42703 x', MARK]).same).toBe(false);
    expect(judgeSample(FAIL_CODE, ['ok']).same).toBe(false);
  });
  it('fail 没写码：照旧任何失败都算（只为兼容旧样例；新样例要写码）', () => {
    expect(judgeSample(FAIL, [MARK]).same).toBe(true);
    expect(judgeSample(FAIL, ['ok']).same).toBe(false);
    expect(() => sampleExpectation('-- expect-old-client: ok 42703\n')).toThrow();
  });
  it('复查 C1：仓库里每个 fail 样例都写了 SQLSTATE（不写码时随便失败都算符合）', () => {
    const dir = join(root, 'supabase', 'tests', 'compat');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.psql') && !f.startsWith('_'))) {
      const sql = readFileSync(join(dir, f), 'utf8');
      if (sampleExpectation(sql) === 'fail') expect(sampleFailCode(sql), f).toMatch(/^[0-9A-Z]{5}$/);
    }
  });
  it('复查 C2：ci.yml 里打过标记以后的每个 db reset，下一条命令就是重新打标记', () => {
    const lines = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').split('\n').map((l) => l.trim());
    const MARK = "alter database postgres set lemo.test_target = 'ci'";
    const first = lines.findIndex((l) => l.includes(MARK));
    expect(first).toBeGreaterThan(0);
    const resets = lines.map((l, i) => (/^supabase db reset\b/.test(l) ? i : -1)).filter((i) => i > first);
    expect(resets.length).toBeGreaterThan(0);
    for (const i of resets) {
      const next = lines.slice(i + 1).find((l) => l !== '' && !l.startsWith('#'));
      expect(next, `第 ${i + 1} 行的 db reset 后面`).toContain(MARK);
    }
  });
  it('CI 的兼容样例循环：每次 db reset 之后、跑样例之前重新打 rls 标记', () => {
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const step = ci.slice(ci.indexOf('- name: 兼容样例（test:compat --sample'), ci.indexOf('- name: 停掉本地 Supabase'));
    const reset = step.indexOf('supabase db reset');
    const mark = step.indexOf("alter database postgres set lemo.test_target = 'ci'");
    const run = step.indexOf('npm run test:compat -- tests/compat --sample');
    expect(reset).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(reset);
    expect(run).toBeGreaterThan(mark);
  });
});
