// account status 探测（platform/account-status.ts；R-256 ③ 及后续）：带令牌调用、四种结果怎么映射成退出原因
import { describe, expect, it, vi } from 'vitest';
import { exitAfterProbe, exitForDisabled, probeAccountForExit, probeAccountStatus } from '../account-status.ts';
import type { Db } from '../supabase/client.ts';

function fakeDb(res: { data: unknown; error: unknown }) {
  const invoke = vi.fn(async () => res);
  return { invoke, getDb: async () => ({ functions: { invoke } }) as unknown as Db };
}

describe('probeAccountStatus', () => {
  it('给了 token：Authorization 用它（被拒那次会话的令牌）；不给不带这个头', async () => {
    const a = fakeDb({ data: { ok: true, status: 'pending_deletion', purge_after: null }, error: null });
    expect(await probeAccountStatus({ getDb: a.getDb, token: 'tok-1' })).toEqual({ kind: 'pending_deletion', purgeAfter: null });
    expect(a.invoke).toHaveBeenCalledWith('account', { body: { action: 'status' }, headers: { Authorization: 'Bearer tok-1' } });
    const b = fakeDb({ data: { ok: true, status: 'active' }, error: null });
    await probeAccountStatus({ getDb: b.getDb });
    expect(b.invoke).toHaveBeenCalledWith('account', { body: { action: 'status' } });
  });

  it('拿不到客户端、超时：unknown（永远 resolve）', async () => {
    expect(await probeAccountStatus({ getDb: () => Promise.reject(new Error('x')) })).toEqual({ kind: 'unknown' });
    const hang = { functions: { invoke: () => new Promise(() => undefined) } } as unknown as Db;
    expect(await probeAccountStatus({ getDb: async () => hang, timeoutMs: 5 })).toEqual({ kind: 'unknown' });
  });
});

describe('probeAccountForExit：错误码 unauthorized、session_revoked 认成 signed_out（登录页的 probeAccountStatus 仍当 unknown）', () => {
  const httpErr = (status: number, error: string) => ({ context: new Response(JSON.stringify({ error }), { status }) });
  it.each([
    [401, 'unauthorized'],
    [403, 'session_revoked'],
  ])('%s %s → signed_out；登录页 unknown', async (status, code) => {
    const a = fakeDb({ data: null, error: httpErr(status, code) });
    expect(await probeAccountForExit({ getDb: a.getDb, token: 't' })).toEqual({ kind: 'signed_out' });
    const b = fakeDb({ data: null, error: httpErr(status, code) });
    expect(await probeAccountStatus({ getDb: b.getDb })).toEqual({ kind: 'unknown' });
  });

  it('不带错误码的 401（令牌过期等，复审建议 10-30）：unknown，主 App 提示 disabled_unsure', async () => {
    const a = fakeDb({ data: null, error: httpErr(401, '') });
    const r = await probeAccountForExit({ getDb: a.getDb, token: 't' });
    expect(r).toEqual({ kind: 'unknown' });
    expect(exitAfterProbe(r)).toBe('disabled_unsure');
  });

  it('try_later、断网仍是 unknown', async () => {
    expect(await probeAccountForExit({ getDb: fakeDb({ data: null, error: httpErr(503, 'try_later') }).getDb })).toEqual({ kind: 'unknown' });
    expect(await probeAccountForExit({ getDb: fakeDb({ data: null, error: new Error('net') }).getDb })).toEqual({ kind: 'unknown' });
  });
});

describe('exitAfterProbe：主 App 收到 account_disabled 后', () => {
  it('pending_deletion → 冷静期；disabled → 停用；unknown → disabled_unsure（保守清本机、提示不确定）；active → 不清', () => {
    expect(exitAfterProbe({ kind: 'pending_deletion', purgeAfter: null })).toBe('pending_deletion');
    expect(exitAfterProbe({ kind: 'disabled' })).toBe('disabled');
    expect(exitAfterProbe({ kind: 'unknown' })).toBe('disabled_unsure');
    expect(exitAfterProbe({ kind: 'active' })).toBe('active');
    expect(exitAfterProbe({ kind: 'signed_out' })).toBe('removed');
  });
});

describe('exitForDisabled（sync-wiring、告知页、设置页、files 共用）', () => {
  const me = () => ({ sid: 's1', token: 'tok-1' });
  it('用被拒那次会话（sid 对得上）的令牌探测，按 exitAfterProbe 定', async () => {
    const probe = vi.fn(async () => ({ kind: 'pending_deletion' as const, purgeAfter: null }));
    expect(await exitForDisabled('s1', { readSession: me, probe })).toBe('pending_deletion');
    expect(probe).toHaveBeenCalledWith('tok-1');
    expect(await exitForDisabled('s1', { readSession: me, probe: async () => ({ kind: 'active' }) })).toBe('active');
    expect(await exitForDisabled('s1', { readSession: me, probe: async () => ({ kind: 'signed_out' }) })).toBe('removed');
  });

  it('本机会话已不是 sid、sid 为 null、读会话抛错：不探测，按 unknown（disabled_unsure）', async () => {
    const probe = vi.fn(async () => ({ kind: 'active' as const }));
    expect(await exitForDisabled('s1', { readSession: () => ({ sid: 's2', token: 'tok-2' }), probe })).toBe('disabled_unsure');
    expect(await exitForDisabled(null, { readSession: me, probe })).toBe('disabled_unsure');
    expect(await exitForDisabled('s1', { readSession: () => { throw new Error('x'); }, probe })).toBe('disabled_unsure');
    expect(probe).not.toHaveBeenCalled();
  });

  it('探测抛错按 unknown；给了 fallback 时 unknown 用它（码精确的 account 函数一路传 disabled），其余结果不受影响', async () => {
    expect(await exitForDisabled('s1', { readSession: me, probe: async () => { throw new Error('x'); } })).toBe('disabled_unsure');
    expect(await exitForDisabled('s1', { readSession: me, probe: async () => ({ kind: 'unknown' }), fallback: 'disabled' })).toBe('disabled');
    const pd = async () => ({ kind: 'pending_deletion' as const, purgeAfter: null });
    expect(await exitForDisabled('s1', { readSession: me, probe: pd, fallback: 'disabled' })).toBe('pending_deletion');
  });
});
