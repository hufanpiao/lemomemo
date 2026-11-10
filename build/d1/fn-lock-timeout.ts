// D1 第 6 节：服务器函数用的十一个函数必须带函数级 lock_timeout = 5s（迁移 20261031130000 的四个，安全审查第 22 条建议 ②；
// 20261031140000 加 account_restore，接手清单 LOCK-restore；20261031150000 的 invite_claim、invite_release，
// 20261031160000 的 orphan_auth_users（ORPHAN-alert）、20261103130000 的 remind_queue_pop、20261103140000 的 remind_due、remind_pushed（B2 BE-2）、20261104130000 的 remind_queue_finish 和重建的 remind_queue_pop（REMIND-queue-crash-loss）建函数时就带）。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、proconfig），单测 tests/build/d1-fn-lock-timeout.test.ts，
// 反例 supabase/tests/d1-fixtures/37_fn_lock_timeout_reset.psql。

/** 必须带 lock_timeout 的函数（private 下的名字）→ 要求的值（和 proconfig 里的写法一致） */
export const LOCK_TIMEOUT_FNS: Readonly<Record<string, string>> = {
  take_rate: 'lock_timeout=5s',
  export_job_start: 'lock_timeout=5s',
  export_job_take: 'lock_timeout=5s',
  account_request_deletion: 'lock_timeout=5s',
  account_restore: 'lock_timeout=5s',   // 迁移 20261031140000
  invite_claim: 'lock_timeout=5s',      // 迁移 20261031150000（建函数时就带）
  invite_release: 'lock_timeout=5s',
  orphan_auth_users: 'lock_timeout=5s', // 迁移 20261031160000（建函数时就带）
  remind_queue_pop: 'lock_timeout=5s',  // 迁移 20261103130000（BE-2，建函数时就带）
  remind_due: 'lock_timeout=5s',  // 迁移 20261103140000（BE-2，建函数时就带）
  remind_pushed: 'lock_timeout=5s',  // 迁移 20261103140000（BE-2，建函数时就带）
  remind_queue_finish: 'lock_timeout=5s',  // 迁移 20261104130000（REMIND-queue-crash-loss，建函数时就带；同一迁移重建的 remind_queue_pop(int, int, boolean) 也带）
  push_heartbeat_write: 'lock_timeout=5s',  // 迁移 20261105140000（REMIND-poison-atomic，建函数时就带）
  ai_quota_take: 'lock_timeout=5s',  // 迁移 20261107100000（B3，建函数时就带）
  ai_quota_refund: 'lock_timeout=5s',
  intake_insert: 'lock_timeout=5s',
  ai_classify_pending: 'lock_timeout=5s',  // 迁移 20261110121000（B4，建函数时就带）
};

export interface FnConfigRow { s: string; f: string; config: string[] | null }

export function lockTimeoutProblems(fns: readonly FnConfigRow[], want: Readonly<Record<string, string>> = LOCK_TIMEOUT_FNS): string[] {
  const out: string[] = [];
  for (const [name, setting] of Object.entries(want)) {
    const rows = fns.filter((x) => x.s === 'private' && x.f === name);
    // 函数还没建就跳过不报（和 FUNCTION_EXEC 同口径）。少了函数由 pgTAP 25_fn_lock_timeout 第 1 条兜底：
    // 那条把四个函数的名字和 proconfig 拼成一串比原文，少一个就失败
    if (!rows.length) continue;
    for (const r of rows) {
      const lt = (r.config ?? []).filter((c) => c.startsWith('lock_timeout='));
      if (lt.length !== 1 || lt[0] !== setting) {
        out.push(`private.${name} 的函数级 lock_timeout 应为 ${setting.slice('lock_timeout='.length)}（迁移 20261031130000～20261031160000；现在：${lt.join(', ') || '没设'}）`);
      }
    }
  }
  return out;
}
