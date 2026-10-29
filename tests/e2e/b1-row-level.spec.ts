// B1 K16：B1 接手清单 T1（TC-B0-89 里两条行级断言不是授权格，要不要另立用例）
//
// QA 的判断：
//   ① devices“只能动本会话那一行”：真库 pgTAP 已由 D-12 的 12 条覆盖（supabase/tests/rls/01_client_rls.test.sql，
//      改、删别的会话的行和 session_id 为空的行各两条，本机一行能改能删作对照），不再另立 pgTAP 用例；
//      这里加一条覆盖守门（现在就跑）：那几条断言被删掉或改掉就失败。
//   ② report_tz_impl“只改自己的行”（N2）：函数随 B1 新迁移建（架构 0.31 第 23 条），B0 里没有，D-12 管不到，要另立：
//      守门条在迁移里出现 private.report_tz_impl 之后，要求 supabase/tests/rls/ 里有提到它的断言；迁移还没建时跳过并写明原因。
//   ③ 两条都补一遍真登录的端到端（经 /sb、浏览器里真的会话 JWT）：原来在这里 test.fixme 着，已搬到真后端组
//      tests/e2e/b1-row-level.real.spec.ts（E2E-REAL 第 5 步，npm run e2e:real 跑；createAccount + loginViaOtp，不发信）。
// 守门条只读仓库文件，和浏览器无关，只在 chromium project 跑一次。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './csp-fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const RLS_DIR = join(ROOT, 'supabase', 'tests', 'rls');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

function readAll(dir: string, ext: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/** 去掉 SQL 的 -- 行注释，免得注释里提到就算“有断言” */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

test.describe('T1 覆盖守门（只读仓库文件）', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', '和浏览器无关，只在 chromium project 跑一次');

  test('① devices 只能动本会话那一行：D-12 的 pgTAP 断言都还在（改、删别的会话和空会话的行；本机一行作对照）', () => {
    const sql = stripComments(readFileSync(join(RLS_DIR, '01_client_rls.test.sql'), 'utf8'));
    // 0b = 同一用户另一会话的设备，0c = session_id 为空的设备，0d = 本机那一行（对照）
    const id = (n: string) => `de000000-0000-4000-8000-00000000000${n}`;
    const upd = (n: string) => new RegExp(`update public\\.devices set [^$]*where id = '${id(n)}'`);
    const del = (n: string) => new RegExp(`delete from public\\.devices where id = '${id(n)}'`);
    const checks: [string, RegExp][] = [
      ['改另一会话的设备', upd('b')],
      ['删另一会话的设备', del('b')],
      ['改 session_id 为空的设备', upd('c')],
      ['删 session_id 为空的设备', del('c')],
      ['对照：改本机设备', upd('d')],
      ['对照：删本机设备', del('d')],
    ];
    for (const [what, re] of checks) expect(sql, what).toMatch(re);
    // 每种反例都核对了“行不变”（读回 label 或行数）
    for (const n of ['b', 'c']) {
      expect(sql, `设备 ${n} 读回核对`).toMatch(new RegExp(`select (label|count\\(\\*\\)::int) from public\\.devices where id = '${id(n)}'`));
    }
  });

  test('② report_tz_impl 只改自己的行：迁移建了函数，就要有对应的 pgTAP 断言', () => {
    const defined = readAll(MIGRATIONS_DIR, '.sql').filter((m) =>
      /create\s+(or\s+replace\s+)?function\s+private\.report_tz_impl\b/i.test(stripComments(m.text)),
    );
    test.skip(defined.length === 0, 'B1 迁移还没建 private.report_tz_impl（架构 0.31 第 23 条），建了以后这一条自动生效');
    const asserting = readAll(RLS_DIR, '.sql').filter((f) => /report_tz(_impl)?\s*\(/.test(stripComments(f.text)));
    expect(
      asserting.map((f) => f.name),
      `迁移 ${defined.map((m) => m.name).join('、')} 建了 report_tz_impl，supabase/tests/rls/ 里要有“B 调它改不到 A 的行”的断言`,
    ).not.toEqual([]);
  });
});
