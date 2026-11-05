// D1 第 6 节之二：往 private.remind_queue 插入的 private 函数，冲突时一律清租约（REMIND-queue-crash-loss 方案丙，迁移 20261104130000）。
// 为什么要查：第 0 步处理完按租约删（remind_queue_finish）。哪个入队入口还是 on conflict do nothing，那一项正被租着的时候用户又改了这一行，
//   新改动不会清租约，finish 就把它删了——退回“先读后删”吞掉新改动的老问题（架构 0.49 第 3 条），而且只坏那一个入口，平时看不出来。
// 11-04 审查返工 L2：冲突时同时把 attempts 清零（用户改了就是新的一次重算），所以要求整句是
//   “on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0”。
// 局限（代码审查 L6）：只按处数比对（插入几处、清租约几处），不认它们是不是一一对应；也查不到 execute 拼出来的动态 SQL。
//   现在 4 个入口都是静态 SQL、每处插入紧跟自己的 on conflict，够用；以后有动态 SQL 入队要另想办法。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、prosrc），单测 tests/build/d1-remind-lease.test.ts，
// 反例 supabase/tests/d1-fixtures/38_enqueue_no_lease_reset.psql。

export interface FnSrcRow { f: string; src: string }
/** checks.ts 用：private 里所有函数的名字和源码 */
export const LEASE_FNS_SQL = `select p.proname as f, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`;

const INSERT_RE = /\binsert\s+into\s+private\.remind_queue\b/gi;
const RESET_RE = /\bon\s+conflict\s*\(\s*table_name\s*,\s*id\s*\)\s*do\s+update\s+set\s+claim\s*=\s*null\s*,\s*claimed_at\s*=\s*null\s*,\s*attempts\s*=\s*0\b/gi;

/** 每处 insert into private.remind_queue 都要配一处“on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0” */
export function leaseResetProblems(fns: readonly FnSrcRow[]): string[] {
  const out: string[] = [];
  for (const r of fns) {
    const ins = (r.src.match(INSERT_RE) ?? []).length;
    if (ins === 0) continue;
    const ok = (r.src.match(RESET_RE) ?? []).length;
    if (ok < ins) {
      out.push(`private.${r.f} 往 remind_queue 插入 ${ins} 处，只有 ${ok} 处冲突时清租约（要写 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0；迁移 20261104130000）`);
    }
  }
  return out;
}
