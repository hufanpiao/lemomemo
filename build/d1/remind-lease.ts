// D1 第 6 节之二：提醒队列的唯一入口（架构约定 10.1；R-411 迁移 20261113100000，取代 20261104130000 起的“数处数”比对）。
// ① 往 private.remind_queue 插入只准在 private.remind_enqueue 里做：别的函数自己写一句 insert，条件、prio、清租约就又多一份（重写前是 4 个函数 6 句）。
// ② remind_enqueue 里那一句冲突时必须换主人并清租约、attempts 清零：
//   “on conflict (table_name, id) do update set user_id = excluded.user_id, claim = null, claimed_at = null, attempts = 0”。
//   为什么要查：第 0 步处理完按租约删（remind_queue_finish）。正被租着的时候用户又改了这一行，不清租约的话 finish 就把新改动删了
//   （架构 0.49 第 3 条“先读后删”的老问题，REMIND-queue-crash-loss）；不换 user_id 的话行被硬删后同一个 id 被别人重用，队列项还挂在原主人名下。
// 局限：只认静态 SQL；execute 拼出来的动态 SQL 查不到。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、prosrc），单测 tests/build/d1-remind-lease.test.ts，
// 反例 supabase/tests/d1-fixtures/38_enqueue_no_lease_reset.psql（别的函数写队列）、48_enqueue_reset_missing.psql（唯一入口不清租约）。

export interface FnSrcRow { f: string; src: string }
/** checks.ts 用：private 里所有函数的名字和源码 */
export const LEASE_FNS_SQL = `select p.proname as f, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`;

/** 写队列的唯一入口 */
export const ENQUEUE_FN = 'remind_enqueue';
const INSERT_RE = /\binsert\s+into\s+private\s*\.\s*remind_queue\b/gi;
const RESET_RE = /\bon\s+conflict\s*\(\s*table_name\s*,\s*id\s*\)\s*do\s+update\s+set\s+user_id\s*=\s*excluded\s*\.\s*user_id\s*,\s*claim\s*=\s*null\s*,\s*claimed_at\s*=\s*null\s*,\s*attempts\s*=\s*0\b/i;

/** remind_enqueue 以外写了 remind_queue 的函数各报一条；remind_enqueue 没有、写了不止一句、冲突时不换主人不清租约，各报一条 */
export function leaseResetProblems(fns: readonly FnSrcRow[]): string[] {
  const out: string[] = [];
  for (const r of fns) {
    const ins = (r.src.match(INSERT_RE) ?? []).length;
    if (ins > 0 && r.f !== ENQUEUE_FN) out.push(`private.${r.f} 直接往 remind_queue 插入（一律改调 private.${ENQUEUE_FN}；R-411 迁移 20261113100000）`);
  }
  const e = fns.filter((r) => r.f === ENQUEUE_FN);
  if (e.length === 0) out.push(`private.${ENQUEUE_FN} 不在（写提醒队列的唯一入口，R-411 迁移 20261113100000）`);
  for (const r of e) {
    const ins = (r.src.match(INSERT_RE) ?? []).length;
    if (ins !== 1) out.push(`private.${ENQUEUE_FN} 里往 remind_queue 插入 ${ins} 句（只准一句，各 scope 写在同一句的 select 里）`);
    if (!RESET_RE.test(r.src)) {
      out.push(`private.${ENQUEUE_FN} 冲突时不换主人、不清租约（要写 on conflict (table_name, id) do update set user_id = excluded.user_id, claim = null, claimed_at = null, attempts = 0；迁移 20261104130000、20261113100000）`);
    }
  }
  return out;
}
