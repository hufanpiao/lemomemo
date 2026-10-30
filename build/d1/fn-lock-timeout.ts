// D1 第 6 节：服务器函数用的五个函数必须带函数级 lock_timeout = 5s（迁移 20261031130000 的四个，安全审查第 22 条建议 ②；
// 20261031140000 加 account_restore，接手清单 LOCK-restore）。
// 纯函数：入参是 checks.ts 查出的 private 函数（名字、proconfig），单测 tests/build/d1-fn-lock-timeout.test.ts，
// 反例 supabase/tests/d1-fixtures/37_fn_lock_timeout_reset.psql。

/** 必须带 lock_timeout 的函数（private 下的名字）→ 要求的值（和 proconfig 里的写法一致） */
export const LOCK_TIMEOUT_FNS: Readonly<Record<string, string>> = {
  take_rate: 'lock_timeout=5s',
  export_job_start: 'lock_timeout=5s',
  export_job_take: 'lock_timeout=5s',
  account_request_deletion: 'lock_timeout=5s',
  account_restore: 'lock_timeout=5s',   // 迁移 20261031140000
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
        out.push(`private.${name} 的函数级 lock_timeout 应为 ${setting.slice('lock_timeout='.length)}（迁移 20261031130000、20261031140000；现在：${lt.join(', ') || '没设'}）`);
      }
    }
  }
  return out;
}
