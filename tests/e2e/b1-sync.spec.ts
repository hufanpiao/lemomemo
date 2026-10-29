// B1 K8 同步的端到端（TC-B1-23、24、27、28、29、59）
//
// 现在能跑的：守门条（只读仓库文件，和浏览器无关，只在 chromium project 跑一次）——
//   ① apply_patch 建了以后，参数名、顺序和 K8 的调用一致（platform/supabase/sync-transport.ts 按名字传参）；还没建时跳过并写明原因；
//   ② tombstones 在 Realtime publication 里（K8 订阅它的 INSERT）；
//   ③ report_tz_impl 的返回值都在 K8 认识的 TzReportResult 里（rate_limited：接手清单 K8-tz-rl）。
// 要真后端的：两个浏览器上下文登录同一账号、经 /sb 打本地或预览的 Supabase。现在 e2e 的 /sb 指向假后端（没有 RLS、没有 Realtime、
//   没有 apply_patch），界面也还没有能改同一条的页面（B2 起），所以先用 test.fixme 写好步骤；有了 LEMO_E2E_PREVIEW_URL 和 B2 的页面后补实现。
//   这几条的逻辑在单元测试里已经用内存里的“契约替身”覆盖（src/core/sync/__tests__/send.test.ts、engine.test.ts）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './csp-fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const allSql = (): string =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .join('\n');

/** K8 认识的 report_tz 返回值（core/sync/types.ts 的 TzReportResult） */
const TZ_RESULTS = ['accepted', 'pending', 'unchanged', 'fixed', 'phone_priority', 'rate_limited'];

test.describe('K8 守门（只读仓库文件）', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', '和浏览器无关，只在 chromium project 跑一次');

  test('① apply_patch 的签名和 K8 的调用一致（4.4）', () => {
    const m = /create\s+(?:or\s+replace\s+)?function\s+public\.apply_patch\s*\(([^)]*)\)/i.exec(allSql());
    test.skip(!m, 'B1 迁移还没建 public.apply_patch（后端 B1 另建，见 supabase/tests/rls/03_roles_grants.test.sql 的说明），建了以后这一条自动生效');
    const names = (m?.[1] ?? '').split(',').map((p) => p.trim().split(/\s+/)[0]);
    expect(names).toEqual(['p_table', 'p_id', 'p_patch', 'p_base_rev', 'p_op_id', 'p_own_revs']);
  });

  test('② tombstones 在 Realtime publication 里（K8 只订阅它的 INSERT）', () => {
    expect(allSql()).toMatch(/alter\s+publication\s+supabase_realtime\s+add\s+table[^;]*public\.tombstones/i);
  });

  test('③ report_tz_impl 的返回值都是 K8 认识的（含 rate_limited）', () => {
    const sql = allSql();
    const at = sql.search(/create\s+(?:or\s+replace\s+)?function\s+private\.report_tz_impl/i);
    test.skip(at < 0, 'B1 迁移还没建 private.report_tz_impl');
    const body = sql.slice(at, sql.indexOf('$$;', sql.indexOf('$$', at) + 2));
    const returned = [...body.matchAll(/return\s+'([a-z_]+)'/g)].map((x) => x[1]);
    expect(returned.length).toBeGreaterThan(0);
    for (const r of returned) expect(TZ_RESULTS, `report_tz 返回了 K8 不认识的 ${r}`).toContain(r);
  });
});

test.describe('K8 端到端（要真后端）', () => {
  const base = process.env['LEMO_E2E_PREVIEW_URL'];
  test.skip(!base, '没有真后端：需要 LEMO_E2E_PREVIEW_URL（预览部署地址）、后端的 apply_patch 和 Realtime、B2 能改条目的页面');

  test.fixme('TC-B1-23 两个浏览器同时改同一条的同一字段：后到的一边出冲突提示', async () => {
    // 两个上下文登录同一个 e2e 账号 → 都打开同一条待办 → 同时改标题 → 后保存的一边看到“已在另一台设备上改过”，两边最终都是后保存的值
  });

  test.fixme('TC-B1-24 同一设备在途期间连续改同一字段 3 次、30 次：全部 ok，不出冲突副本', async () => {
    // 用 route 让 /sb/rest/v1/rpc/apply_patch 的响应晚 1 秒回 → 在途期间连续改标题 3 次、30 次 → 抓所有 apply_patch 响应，status 全是 ok
  });

  test.fixme('TC-B1-27 离线记 10 条（含 1 条带提醒），恢复网络后全部同步，带提醒的先发', async () => {
    // context.setOffline(true) → 记 10 条 → setOffline(false) → 等 outbox 清空 → 服务器上 10 条都在；第一个写请求是带提醒的那条
  });

  test.fixme('TC-B1-28 一边新增、修改，另一边经 Realtime 实时看到；断开 Realtime 只留轮询也能收到', async () => {
    // 两个上下文 → A 新增、修改 → B 不刷新就看到 → 让 B 的 /sb/realtime 连不上 → A 再改 → B 在 60 秒轮询内收到
  });

  test.fixme('TC-B1-59 永久删除写墓碑：另一台设备经增量同步或 Realtime 删掉本机行', async () => {
    // A、B 都有一条已软删除的待办 → A 在“最近删除”里永久删除（B4 起有按钮；之前直接调 purge_deleted）→ B 的本机库里这一行没了
  });
});
