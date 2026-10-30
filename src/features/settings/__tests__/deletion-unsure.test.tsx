// 安全审查 H1（架构 0.47 第 22 条 T4）：申请注销回 try_later，查 status 只查到会话已失效时提示 deletion_unsure，不说冷静期；
// 本页同时收到 SIGNED_OUT（getSession 刷新被拒）时两条退出路只走一条，登录页的提示以 deletion_unsure 为准
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import type { AccountProbe } from '../../../platform/account-status.ts';
import { clearExitNotice, goToAuth, readExitNotice, setExitNotice } from '../../../platform/session.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { createAccountApi } from '../data/account-api.ts';
import { checkDeletion } from '../data/deletion-check.ts';
import { createLeaveAccount, type AccountLeaveDeps } from '../data/account-exit.ts';
import { useDeleteAccount } from '../hooks/useAccountActions.ts';

const b64 = (o: unknown): string => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', session_id: 's-1' })}.sig`;

function db(): () => Promise<Db> {
  return async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: TOKEN, user: { id: 'u1' } } }, error: null }) } }) as unknown as Db;
}

function leaveDeps(boot: Partial<BootResult> | null) {
  return {
    getBoot: vi.fn(() => boot as BootResult | null),
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => {
      await r.clearCacheStorage();
      r.onRemoved();
    }),
    clearCacheStorage: vi.fn(async () => undefined),
    clearLogs: vi.fn(),
    broadcastReset: vi.fn(),
    clearLocalSessionIf: vi.fn(),
    goToAuth: vi.fn(),
    setNotice: vi.fn((n: Parameters<typeof setExitNotice>[0], sid: string | null) => setExitNotice(n, undefined, { sid })),
  } satisfies AccountLeaveDeps;
}

/** 注销回 503 try_later，status 探测回 probeRes；走真的 account-api → useDeleteAccount → createLeaveAccount */
async function submitWith(probeRes: AccountProbe, d: ReturnType<typeof leaveDeps>) {
  const api = createAccountApi(db(), {
    fetch: (async () => new Response(JSON.stringify({ error: 'try_later' }), { status: 503 })) as never,
    url: 'https://x.test/sb/functions/v1/account',
    anonKey: 'anon',
    readSid: () => 's-1',
    checkDeletion: (sid) => checkDeletion(db(), sid, { probe: async () => probeRes }),
  });
  const leave = createLeaveAccount(d);
  const deps = { api, leave, onRevoked: vi.fn(), onSignedOut: vi.fn() };
  const { result } = renderHook(() => useDeleteAccount(deps, async () => 0));
  await act(async () => {
    await result.current.submit('注销');
  });
  return { result, deps };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearExitNotice();
});

describe('H1：注销 try_later 后按 status 定离开原因', () => {
  it('status 回会话已失效（signed_out）：goToAuth 收到 deletion_unsure 而不是 pending_deletion；会话照删', async () => {
    const d = leaveDeps(null);
    const { deps } = await submitWith({ kind: 'signed_out' }, d);
    expect(d.goToAuth.mock.calls).toEqual([['deletion_unsure']]);
    expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s-1');
    expect(deps.onRevoked).not.toHaveBeenCalled();
  });

  it('status 回冷静期：照旧 pending_deletion', async () => {
    const d = leaveDeps(null);
    await submitWith({ kind: 'pending_deletion', purgeAfter: '2026-11-06T15:30:00Z' }, d);
    expect(d.goToAuth.mock.calls).toEqual([['pending_deletion']]);
  });

  it('status 回 active：不离开，显示稍后再试', async () => {
    const d = leaveDeps(null);
    const { result } = await submitWith({ kind: 'active' }, d);
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'error', error: 'try_later' });
  });
});

describe('H1 ②：本页的 SIGNED_OUT 一路和这里的 leave 只走一条，提示以 deletion_unsure 为准', () => {
  it('SIGNED_OUT 先到（watchAccount 已设闸，boot.switching）：leave 不清第二遍、不跳转，只记下 deletion_unsure；那一路随后的 goToAuth(removed) 不覆盖', async () => {
    vi.stubGlobal('location', { replace: vi.fn() });
    const d = leaveDeps({ switching: true, sessionGone: true, userId: 'u1' });
    await createLeaveAccount(d)('deletion_unsure', 's-1', { revoked: true });
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(d.setNotice).toHaveBeenCalledWith('deletion_unsure', 's-1');
    // watchAccount 的 signedOutHere 清完后调的真 goToAuth
    goToAuth('removed', 's-1');
    expect(readExitNotice()).toBe('deletion_unsure');
  });

  it('闸不是“会话没了”那一路设的（换账号等，boot.sessionGone 没标）：deletion_unsure 也不记，免得留在 sessionStorage 以后冒出来', async () => {
    const d = leaveDeps({ switching: true, userId: 'u1' });
    await createLeaveAccount(d)('deletion_unsure', 's-1', { revoked: true });
    expect(d.setNotice).not.toHaveBeenCalled();
    expect(readExitNotice()).toBeNull();
  });

  it('已经在走别的退出流程时，别的原因不记（只有 deletion_unsure 例外）', async () => {
    for (const n of ['pending_deletion', 'disabled', 'disabled_unsure'] as const) {
      const d = leaveDeps({ switching: true, userId: 'u1' });
      await createLeaveAccount(d)(n, 's-1');
      expect(d.setNotice, n).not.toHaveBeenCalled();
    }
  });

  it('leave 先走（没设闸）：正常清本机并 goToAuth(deletion_unsure)，不另记原因', async () => {
    const d = leaveDeps({ switching: false, userId: 'u1' });
    await createLeaveAccount(d)('deletion_unsure', 's-1', { revoked: true });
    expect(d.wipeOnRemoved).toHaveBeenCalledTimes(1);
    expect(d.goToAuth.mock.calls).toEqual([['deletion_unsure']]);
    expect(d.setNotice).not.toHaveBeenCalled();
  });

  it('竞态（安全复核建议）：SIGNED_OUT 那一路先 goToAuth(removed) 写下原因，leave 的 deletion_unsure 后到：登录页不出现冷静期文字', async () => {
    vi.stubGlobal('location', { replace: vi.fn() });
    goToAuth('removed', 's-1');
    expect(readExitNotice()).toBe('removed');
    const d = leaveDeps({ switching: true, sessionGone: true, userId: 'u1' });
    await createLeaveAccount(d)('deletion_unsure', 's-1', { revoked: true });
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
    expect(d.goToAuth).not.toHaveBeenCalled();
    const final = readExitNotice();
    expect(final).not.toBe('pending_deletion');
    // 有意为之：刚申请注销时以 deletion_unsure 为准（后到的覆盖 removed；主持人 10-31 定，比“被移除”贴切，也没有冷静期文字）
    expect(final).toBe('deletion_unsure');
  });
});
