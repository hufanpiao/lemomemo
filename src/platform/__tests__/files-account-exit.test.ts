// files 的 account 类错误 → 退出原因（platform/files.ts 的 accountExitOf；R-256 ③、PROBE-sugg ②）：
// session_revoked → removed；account_disabled（code 或 reason）先探测（exitForDisabled）；不是 account 类返回 null
import { describe, expect, it, vi } from 'vitest';
import { accountExitOf, classify, type FileError } from '../files.ts';

const err = (status: number, code: string, reason?: string): FileError => {
  const e: FileError = { ok: false, kind: classify(status, code, reason), code, status };
  if (reason !== undefined) e.reason = reason;
  return e;
};
const me = () => ({ sid: 's1', token: 'tok-1' });

describe('accountExitOf', () => {
  it('account_disabled（code 或 forbidden 带的 reason）：先探测，冷静期给 pending_deletion', async () => {
    const probe = vi.fn(async () => ({ kind: 'pending_deletion' as const, purgeAfter: null }));
    expect(await accountExitOf(err(403, 'account_disabled'), 's1', { readSession: me, probe })).toBe('pending_deletion');
    expect(await accountExitOf(err(403, 'forbidden', 'account_disabled'), 's1', { readSession: me, probe })).toBe('pending_deletion');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('探测不出 → disabled_unsure；账号正常 → active', async () => {
    expect(await accountExitOf(err(403, 'account_disabled'), 's1', { readSession: me, probe: async () => ({ kind: 'unknown' }) })).toBe('disabled_unsure');
    expect(await accountExitOf(err(403, 'account_disabled'), 's1', { readSession: me, probe: async () => ({ kind: 'active' }) })).toBe('active');
  });

  it('session_revoked 不探测，直接 removed；不是 account 类返回 null', async () => {
    const probe = vi.fn(async () => ({ kind: 'active' as const }));
    expect(await accountExitOf(err(401, 'session_revoked'), 's1', { readSession: me, probe })).toBe('removed');
    expect(await accountExitOf(err(401, 'unauthorized'), 's1', { readSession: me, probe })).toBeNull();
    expect(await accountExitOf(err(503, 'try_later'), 's1', { readSession: me, probe })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
