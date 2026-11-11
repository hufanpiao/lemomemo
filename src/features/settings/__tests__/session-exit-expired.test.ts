// R-382（架构 4.1a 第 1 点 ②）：设置页和插图上传收到 session_revoked 先定结局——expired 只关库、不清，删那一个会话、回登录页“登录已过期”；
// removed 照旧清库。path 记 settings / files
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { createLeaveAccount } from '../data/account-exit.ts';
import { useSessionExit } from '../hooks/useSessionExit.ts';
import { fakeApi, fakeExit } from './fakes.tsx';

describe('设置页 onRevoked', () => {
  it('判 expired：expireHere(sid) → 删那个会话 → goToAuthExpired(sid)；不清库；记 path settings、码 session_revoked', async () => {
    const { exit } = fakeExit();
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    const expireHere = vi.fn(() => true);
    const goToAuthExpired = vi.fn();
    const { result } = renderHook(() => useSessionExit(fakeApi(), { ...exit, resolveAuthLoss, expireHere, goToAuthExpired, lostUserId: () => 'u1' }));
    await act(async () => {
      result.current.onRevoked('s-me');
    });
    await vi.waitFor(() => expect(goToAuthExpired).toHaveBeenCalledWith('s-me'));
    expect(resolveAuthLoss).toHaveBeenCalledWith({ path: 'settings', code: 'session_revoked', sessionId: 's-me', userId: 'u1' });
    expect(expireHere).toHaveBeenCalledWith('s-me');
    expect(exit.clearLocalSessionIf).toHaveBeenCalledWith('s-me');
    expect(exit.wipe).not.toHaveBeenCalled();
  });

  it('判 removed：不调 expireHere，照旧按被移除（提示 revoked）', async () => {
    const { exit } = fakeExit();
    const expireHere = vi.fn(() => true);
    const goToAuthExpired = vi.fn();
    const { result } = renderHook(() =>
      useSessionExit(fakeApi(), { ...exit, resolveAuthLoss: async () => 'removed', expireHere, goToAuthExpired, lostUserId: () => 'u1' }));
    await act(async () => {
      result.current.onRevoked('s-me');
    });
    await vi.waitFor(() => expect(result.current.notice).toBe('revoked'));
    expect(expireHere).not.toHaveBeenCalled();
    expect(goToAuthExpired).not.toHaveBeenCalled();
  });

  it('查 session_fate 之前先 markHere（设闸、写记号，独立验证建议 3）：先于 resolveAuthLoss 调', async () => {
    const { exit } = fakeExit();
    const order: string[] = [];
    const markHere = vi.fn(() => (order.push('mark'), true));
    const resolveAuthLoss = vi.fn(async () => (order.push('resolve'), 'expired' as const));
    const goToAuthExpired = vi.fn();
    const { result } = renderHook(() =>
      useSessionExit(fakeApi(), { ...exit, markHere, resolveAuthLoss, expireHere: () => true, goToAuthExpired, lostUserId: () => 'u1' }));
    await act(async () => {
      result.current.onRevoked('s-me');
    });
    await vi.waitFor(() => expect(goToAuthExpired).toHaveBeenCalledWith('s-me'));
    expect(markHere).toHaveBeenCalledWith('s-me');
    expect(order).toEqual(['mark', 'resolve']);
  });

  it('markHere 写不了记号：不查 session_fate，直接按被移除（提示 revoked）', async () => {
    const { exit } = fakeExit();
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    const goToAuthExpired = vi.fn();
    const { result } = renderHook(() =>
      useSessionExit(fakeApi(), { ...exit, markHere: () => false, resolveAuthLoss, expireHere: () => true, goToAuthExpired, lostUserId: () => 'u1' }));
    await act(async () => {
      result.current.onRevoked('s-me');
    });
    await vi.waitFor(() => expect(result.current.notice).toBe('revoked'));
    expect(resolveAuthLoss).not.toHaveBeenCalled();
    expect(goToAuthExpired).not.toHaveBeenCalled();
  });
});

describe('createLeaveAccount(removed) 的 R-382 路径（插图上传 path files）', () => {
  const base = () => ({
    getBoot: () => ({ switching: false, userId: 'u1' }) as BootResult,
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => r.onRemoved()),
    clearCacheStorage: vi.fn(async () => undefined),
    clearLogs: vi.fn(),
    broadcastReset: vi.fn(),
    clearLocalSessionIf: vi.fn(async () => true),
    goToAuth: vi.fn(),
    goToAuthExpired: vi.fn(),
  });

  it('判 expired：expire → 广播带 expired 的 reset → 删那个会话 → goToAuthExpired；不清库', async () => {
    const d = base();
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    await createLeaveAccount({ ...d, resolveAuthLoss, expire: () => true })('removed', 's-me');
    expect(resolveAuthLoss).toHaveBeenCalledWith({ path: 'files', code: 'session_revoked', sessionId: 's-me', userId: 'u1' });
    expect(d.broadcastReset).toHaveBeenCalledWith('u1', { notice: 'expired', sid: 's-me' });
    expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s-me');
    expect(d.goToAuthExpired).toHaveBeenCalledWith('s-me');
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
  });

  it('判 removed、或 expired 但写不了记号：照旧清库、goToAuth(removed, sid)', async () => {
    for (const [r, kept] of [['removed', true], ['expired', false]] as const) {
      const d = base();
      await createLeaveAccount({ ...d, resolveAuthLoss: async () => r, expire: () => kept })('removed', 's-me');
      expect(d.wipeOnRemoved).toHaveBeenCalledTimes(1);
      expect(d.goToAuth).toHaveBeenCalledWith('removed', 's-me');
      expect(d.goToAuthExpired).not.toHaveBeenCalled();
    }
  });
});
