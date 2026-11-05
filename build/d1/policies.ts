// D1 第 6 节之三：RLS 策略的两条底线（判定在这里，checks.ts 只查库）。
// ① storage.objects 上一条策略都不建（0.32：客户端不直接访问 Supabase Storage，只剩 vault-preview、backups，都只经服务器函数）。
// ② fn_vault、fn_ai 的策略不许放开（HEARTBEAT-fnai-policy，迁移 20261104140000）。
//   fn 角色是会话变量版 RLS（附录 A），表级授权只管“能不能写这张表”，哪些行能写全靠策略。
//   0001 给 private.heartbeat 的 fn_all 是 using (true)，fn_ai 能改写任何服务的心跳（含 account-purge），掩盖别的服务停摆。
//   以后谁再给 fn 角色写一条 using (true) / with check (true)，或在 heartbeat 上另加一条宽的策略（permissive 策略之间是 OR），这里都要失败。
// ③ fn 角色的其余策略（HEARTBEAT-fnai 安全审查 G2，11-05）：using、with check（不为空时）都要用 current_setting('app.uid') 绑定到本人；
//   例外只有 private.counters 的 fn_global（全项目计数，要含 'global'）和 heartbeat（上面逐字比对）。这样 1 = 1、name is not null 这类
//   不写 true 的恒真式也拦得住。拦不住的：含 app.uid 却又 or 上恒真式（例如 … or true）——要逐表逐字比对附录 A 才能拦，
//   成本大，登记在 B1 接手清单 HB-policy-verbatim。
// 纯函数：入参是 checks.ts 查出的 public、private、storage 上全部策略，单测 tests/build/d1-policies.test.ts，
// 反例 supabase/tests/d1-fixtures/20_storage_policy.psql、39～41（heartbeat）。
import { FN_AI_HEARTBEATS } from './whitelist.ts';

export interface PolicyRow { t: string; name: string; cmd: string; permissive: string; roles: string; qual: string | null; with_check: string | null }
/** checks.ts 用：public、private、storage 上全部策略（roles 用逗号连起来） */
export const POLICY_SQL = `select schemaname || '.' || tablename as t, policyname as name, cmd, permissive, array_to_string(roles, ',') as roles, qual, with_check
  from pg_policies where schemaname in ('public', 'private', 'storage')`;

const FN_ROLES = ['fn_vault', 'fn_ai'];
const isTrue = (e: string | null): boolean => e !== null && /^[\s(]*true[\s)]*$/i.test(e);
const APP_UID = "current_setting('app.uid'";
/** 不按本人绑定的例外：表.策略名 → 条件里必须含的片段 */
const NOT_PER_USER: Readonly<Record<string, string>> = { 'private.counters.fn_global': "'global'" };

/** pg_policies 里 name in (…) 反解析出来的样子：(name = ANY (ARRAY['ai-embed'::text, …])) */
export const heartbeatExpr = (names: readonly string[]): string =>
  `(name = ANY (ARRAY[${names.map((n) => `'${n}'::text`).join(', ')}]))`;

function heartbeatProblems(hb: readonly PolicyRow[]): string[] {
  const out: string[] = [];
  const want = heartbeatExpr(FN_AI_HEARTBEATS);
  const own = hb.find((r) => r.name === 'fn_ai_own');
  // 只准有 fn_ai_own 这一条（service_role 绕过 RLS，别的角色不需要策略；多一条宽的就和它 OR 起来）
  for (const r of hb) if (r !== own) out.push(`private.heartbeat 上多了策略 ${r.name}（给 ${r.roles}）：只准有 fn_ai_own 一条`);
  if (!own) return [...out, 'private.heartbeat 上没有策略 fn_ai_own（fn_ai 只能写自己的心跳名，迁移 20261104140000）'];
  if (own.roles !== 'fn_ai' || own.cmd !== 'ALL' || own.permissive !== 'PERMISSIVE') {
    out.push(`private.heartbeat 的 fn_ai_own 应是 for all to fn_ai 的 permissive 策略，实际 ${own.cmd} to ${own.roles} ${own.permissive}`);
  }
  if (own.qual !== want) out.push(`private.heartbeat 的 fn_ai_own using 应是 ${want}，实际 ${own.qual ?? '空'}（名单见 whitelist.ts FN_AI_HEARTBEATS）`);
  if (own.with_check !== want) out.push(`private.heartbeat 的 fn_ai_own with check 应是 ${want}，实际 ${own.with_check ?? '空'}`);
  return out;
}

export function policyProblems(rows: readonly PolicyRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.t === 'storage.objects') {
      out.push(`storage.objects 上有策略 ${r.name}：0.32 起客户端不直接访问 Supabase Storage，不建任何存储策略`);
      continue;
    }
    if (!r.roles.split(',').some((x) => FN_ROLES.includes(x))) continue;
    if (isTrue(r.qual) || isTrue(r.with_check)) {
      out.push(`${r.t} 上给 ${r.roles} 的策略 ${r.name} 是 using (true) / with check (true)：fn 角色的策略要限到本人或固定名单（附录 A；迁移 20261104140000）`);
      continue;
    }
    if (r.t === 'private.heartbeat') continue;   // 下面逐字比对
    const need = NOT_PER_USER[`${r.t}.${r.name}`] ?? APP_UID;
    for (const [what, e] of [['using', r.qual], ['with check', r.with_check]] as const) {
      if (e !== null && !e.includes(need)) {
        out.push(`${r.t} 上给 ${r.roles} 的策略 ${r.name} 的 ${what} 没有 ${need === APP_UID ? '按 app.uid 绑定到本人' : `限到 ${need}`}：${e}（附录 A；HEARTBEAT-fnai 安全审查 G2）`);
      }
    }
  }
  return [...out, ...heartbeatProblems(rows.filter((r) => r.t === 'private.heartbeat'))];
}
