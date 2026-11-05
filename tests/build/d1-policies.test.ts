// D1 第 6 节之三：RLS 策略的两条底线（build/d1/policies.ts；HEARTBEAT-fnai-policy，迁移 20261104140000）。
// 真库上的反例是 supabase/tests/d1-fixtures/20、39～41（离线 PGlite 跑）；这里只测判定逻辑，并核对迁移里的名单和 whitelist.ts 一致。
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heartbeatExpr, policyProblems, type PolicyRow } from '../../build/d1/policies.ts';
import { FN_AI_HEARTBEATS } from '../../build/d1/whitelist.ts';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';
import { HEARTBEAT_LIMITS } from '../../workers/lemo-ops/src/rules.ts';

const WANT = heartbeatExpr(FN_AI_HEARTBEATS);
const own = (o: Partial<PolicyRow> = {}): PolicyRow => ({
  t: 'private.heartbeat', name: 'fn_ai_own', cmd: 'ALL', permissive: 'PERMISSIVE', roles: 'fn_ai', qual: WANT, with_check: WANT, ...o,
});
const fnOwn: PolicyRow = {
  t: 'private.counters', name: 'fn_own', cmd: 'ALL', permissive: 'PERMISSIVE', roles: 'fn_vault,fn_ai',
  qual: "(split_part(key, ':'::text, 2) = NULLIF(current_setting('app.uid'::text, true), ''::text))",
  with_check: "(split_part(key, ':'::text, 2) = NULLIF(current_setting('app.uid'::text, true), ''::text))",
};

describe('policyProblems', () => {
  it('现在的样子：heartbeat 只有 fn_ai_own、其他 fn 策略限本人、客户端的 using (true) 不管：不报', () => {
    expect(heartbeatExpr(['a', 'b'])).toBe("(name = ANY (ARRAY['a'::text, 'b'::text]))");
    expect(policyProblems([own(), fnOwn,
      { t: 'public.app_config', name: 'cfg_sel', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: 'anon,authenticated', qual: 'true', with_check: null },
    ])).toEqual([]);
  });

  it('退回 0001 的 fn_all：报 using (true)，也报没有 fn_ai_own', () => {
    const p = policyProblems([{ ...own({ name: 'fn_all', qual: 'true', with_check: 'true' }) }]);
    expect(p.some((x) => x.includes('给 fn_ai 的策略 fn_all 是 using (true)'))).toBe(true);
    expect(p.some((x) => x.includes('上多了策略 fn_all'))).toBe(true);
    expect(p.some((x) => x.includes('没有策略 fn_ai_own'))).toBe(true);
  });

  it('别的表上给 fn 角色的 using (true) 或 with check (true) 都报（带括号、大小写也认）', () => {
    for (const [qual, wc] of [['true', null], ['(true)', null], [null, 'TRUE'], ["(user_id = x)", ' ( true ) ']] as const) {
      const p = policyProblems([own(), { ...fnOwn, t: 'private.vault_ai', roles: 'fn_ai', qual, with_check: wc }]);
      expect(p, `${qual}/${wc}`).toHaveLength(1);
      expect(p[0]).toContain('private.vault_ai 上给 fn_ai 的策略 fn_own 是 using (true)');
    }
    // 'true' 只是表达式的一部分不算（例如 current_setting('x', true)）
    expect(policyProblems([own(), fnOwn])).toEqual([]);
  });

  it('heartbeat 上多一条策略（哪怕给 public、哪怕看着窄）就报', () => {
    const p = policyProblems([own(), own({ name: 'qa_hb_wide', cmd: 'INSERT', roles: 'public', qual: null, with_check: "(name ~~ '%-%'::text)" })]);
    expect(p).toEqual(['private.heartbeat 上多了策略 qa_hb_wide（给 public）：只准有 fn_ai_own 一条']);
  });

  it('fn_ai_own 的名单、命令、角色、permissive 不对都报', () => {
    const more = heartbeatExpr([...FN_AI_HEARTBEATS, 'ai-classify']);
    expect(policyProblems([own({ qual: more })])).toEqual([expect.stringContaining('fn_ai_own using 应是')]);
    expect(policyProblems([own({ with_check: more })])).toEqual([expect.stringContaining('fn_ai_own with check 应是')]);
    expect(policyProblems([own({ with_check: null })])).toEqual([expect.stringContaining('实际 空')]);
    expect(policyProblems([own({ cmd: 'INSERT' })])).toEqual([expect.stringContaining('应是 for all to fn_ai')]);
    expect(policyProblems([own({ roles: 'fn_ai,fn_vault' })])).toEqual([expect.stringContaining('应是 for all to fn_ai')]);
    expect(policyProblems([own({ permissive: 'RESTRICTIVE' })])).toEqual([expect.stringContaining('应是 for all to fn_ai')]);
  });

  it('storage.objects 上有策略就报（原 checks.ts 的那一条挪到这里）', () => {
    expect(policyProblems([own(), { t: 'storage.objects', name: 'qa_probe', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: 'authenticated', qual: 'x', with_check: null }]))
      .toEqual([expect.stringContaining('storage.objects 上有策略 qa_probe')]);
  });

  it('迁移 20261104140000 里 using、with check 的名单都等于 FN_AI_HEARTBEATS，且不含 service_role 函数的心跳名', () => {
    const sql = readFileSync('supabase/migrations/20261104140000_core_heartbeat_fnai_policy.sql', 'utf8').replace(/--.*$/gm, '');
    const lists = [...sql.matchAll(/name in \(([^)]*)\)/g)].map((m) => [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]));
    expect(lists).toEqual([FN_AI_HEARTBEATS, FN_AI_HEARTBEATS]);
    for (const n of ['ai-classify', 'push-dispatch', 'backup-daily', 'vault-file-sweep', 'account-purge', 'cleanup']) {
      expect(FN_AI_HEARTBEATS).not.toContain(n);
    }
  });

  it('service_role 服务的心跳名从代码里取（安全审查 G1）：lemo-ops 的 HEARTBEAT_LIMITS、usage-report 的白名单、各函数的 HEARTBEAT 常量，都不在 FN_AI_HEARTBEATS 里', () => {
    const fromFns = readdirSync('supabase/functions', { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) =>
      readdirSync(`supabase/functions/${d.name}`).filter((f) => f.endsWith('.ts')).flatMap((f) =>
        [...readFileSync(`supabase/functions/${d.name}/${f}`, 'utf8').matchAll(/export const HEARTBEAT = '([^']+)'/g)].map((m) => m[1] as string)));
    const service = new Set([...Object.keys(HEARTBEAT_LIMITS), ...Object.keys(DETAIL_FIELDS_BY_NAME), ...fromFns]);
    expect(service.size).toBeGreaterThanOrEqual(6);
    expect([...service].filter((n) => FN_AI_HEARTBEATS.includes(n))).toEqual([]);
  });

  it('fn 角色的其余策略要按 app.uid 绑定到本人（安全审查 G2）：1 = 1、key is not null 这类恒真式报；counters.fn_global 例外但要含 global', () => {
    const uid = "(user_id = (NULLIF(current_setting('app.uid'::text, true), ''::text))::uuid)";
    const row = (o: Partial<PolicyRow>): PolicyRow => ({ t: 'private.vault', name: 'fn_own', cmd: 'ALL', permissive: 'PERMISSIVE', roles: 'fn_vault', qual: uid, with_check: uid, ...o });
    expect(policyProblems([own(), row({})])).toEqual([]);
    expect(policyProblems([own(), row({ with_check: null })])).toEqual([]);
    expect(policyProblems([own(), row({ qual: '(1 = 1)' })])).toEqual([expect.stringContaining('using 没有 按 app.uid 绑定到本人')]);
    expect(policyProblems([own(), row({ with_check: '(key IS NOT NULL)' })])).toEqual([expect.stringContaining('with check 没有 按 app.uid 绑定到本人')]);
    expect(policyProblems([own(), row({ roles: 'authenticated', qual: '(1 = 1)' })])).toEqual([]);   // 只管 fn 角色
    const g = "(split_part(key, ':'::text, 2) = 'global'::text)";
    expect(policyProblems([own(), row({ t: 'private.counters', name: 'fn_global', roles: 'fn_ai', qual: g, with_check: g })])).toEqual([]);
    expect(policyProblems([own(), row({ t: 'private.counters', name: 'fn_global', roles: 'fn_ai', qual: '(1 = 1)', with_check: g })]))
      .toEqual([expect.stringContaining("using 没有 限到 'global'")]);
  });
});
