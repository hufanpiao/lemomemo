// D1 第 6 节：十三个写计数、写账号状态、占退邀请码、数孤儿用户、推送出队、到点和 resolve 候选（remind_queue_pop、remind_due、remind_pushed，B2 BE-2）、出队收尾（remind_queue_finish，REMIND-queue-crash-loss）的函数带函数级 lock_timeout = 5s（build/d1/fn-lock-timeout.ts；迁移 20261031130000～20261031160000 和 20261103130000、20261103140000、20261104130000）。
// 真库上的反例是 supabase/tests/d1-fixtures/37（离线 PGlite 跑）；这里只测比对逻辑，并核对迁移里的写法和名单对得上。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCK_TIMEOUT_FNS, lockTimeoutProblems, type FnConfigRow } from '../../build/d1/fn-lock-timeout.ts';

const ok = (f: string, s = 'private'): FnConfigRow => ({ s, f, config: ['search_path=""', 'lock_timeout=5s'] });
const all = () => Object.keys(LOCK_TIMEOUT_FNS).map((f) => ok(f));

describe('lockTimeoutProblems', () => {
  it('十三个函数都带 lock_timeout=5s：不报', () => {
    expect(Object.keys(LOCK_TIMEOUT_FNS).sort()).toEqual(['account_request_deletion', 'account_restore', 'ai_quota_refund', 'ai_quota_take', 'export_job_start', 'export_job_take', 'intake_insert', 'invite_claim', 'invite_release', 'orphan_auth_users', 'push_heartbeat_write', 'remind_due', 'remind_pushed', 'remind_queue_finish', 'remind_queue_pop', 'take_rate']);
    expect(lockTimeoutProblems(all())).toEqual([]);
  });

  it('没设、设成别的值、proconfig 为空：各报一条，写出现在的值', () => {
    const rows = all().map((r) => (r.f === 'take_rate' ? { ...r, config: ['search_path=""'] }
      : r.f === 'export_job_take' ? { ...r, config: ['search_path=""', 'lock_timeout=1min'] }
      : r.f === 'account_request_deletion' ? { ...r, config: null } : r));
    expect(lockTimeoutProblems(rows)).toEqual([
      'private.take_rate 的函数级 lock_timeout 应为 5s（迁移 20261031130000～20261031160000；现在：没设）',
      'private.export_job_take 的函数级 lock_timeout 应为 5s（迁移 20261031130000～20261031160000；现在：lock_timeout=1min）',
      'private.account_request_deletion 的函数级 lock_timeout 应为 5s（迁移 20261031130000～20261031160000；现在：没设）',
    ]);
  });

  it('同名的另一个重载没设也报；public 下的同名函数不算；函数还没建不报', () => {
    const rows = [...all(), { s: 'private', f: 'take_rate', config: ['search_path=""'] }, { s: 'public', f: 'export_job_start', config: null }];
    expect(lockTimeoutProblems(rows)).toEqual(['private.take_rate 的函数级 lock_timeout 应为 5s（迁移 20261031130000～20261031160000；现在：没设）']);
    expect(lockTimeoutProblems([])).toEqual([]);
  });

  it('迁移 20261031130000～20261031160000 和 20261103130000、20261103140000、20261104130000、20261105110000、20261105140000、20261107100000 合起来给名单里每个函数都写了 set lock_timeout = \'5s\'，没有多的', () => {
    const sql = ['20261031130000_core_fn_lock_timeout.sql', '20261031140000_core_restore_lock_timeout.sql', '20261031150000_core_invite_claim.sql', '20261031160000_ops_orphan_auth_users.sql', '20261103130000_core_remind_queue_pop.sql', '20261103140000_core_remind_due.sql', '20261104130000_core_remind_queue_lease.sql', '20261105110000_core_remind_queue_pop_orphan_once.sql', '20261105140000_core_push_heartbeat_atomic.sql', '20261107100000_core_my_ai_usage.sql']
      .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');
    const altered = [...sql.matchAll(/^alter function private\.([a-z_]+)\([^)]*\) set lock_timeout = '5s';$/gm)].map((m) => m[1]);
    // 20261031150000 的两个函数、20261031160000 的 orphan_auth_users、20261103130000 的 remind_queue_pop、20261103140000 的 remind_due、remind_pushed、20261104130000 的 remind_queue_finish 和重建的 remind_queue_pop 建的时候就带：create function private.名字(…) …（下一行）… set lock_timeout = '5s' as $$
    // remind_queue_pop 建过两次（20261103130000 的 (int)，20261104130000 删掉后重建成 (int, int)），20261105110000 又 create or replace 一次（删孤儿只算一次），按名字去重再比
    const created = [...sql.matchAll(/^create (?:or replace )?function private\.([a-z_]+)\([^)]*\)[^\n]*\n[^\n]*set lock_timeout = '5s' as \$\$$/gm)].map((m) => m[1]);
    const set = [...new Set([...altered, ...created])];
    expect(set.sort()).toEqual(Object.keys(LOCK_TIMEOUT_FNS).sort());
    expect(Object.values(LOCK_TIMEOUT_FNS).every((v) => v === 'lock_timeout=5s')).toBe(true);
    expect(sql).not.toMatch(/statement_timeout\s*=/);
  });
});
