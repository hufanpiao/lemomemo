// 安全审查 M3（2026-11-25）：session_fate 的全库每分钟总闸被打满时，服务器回 busy（迁移 20261125100000），客户端按“稍后再查”。
// 整条链用同一个假服务器（按顺序回答）走一遍：
//   主 App 被移除 → 查 session_fate 回 busy → 只退出、记号留着（不清，也不当定论）→ 登录页按退避重查 → 查到 revoked 清库、提示被移除；
//   对照：真没吊销（unknown）照旧只退出、登录页不重查；服务器直接回 revoked 当场清库。
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAuthLossForTest, resolveAuthLoss } from '../../../core/auth-loss.ts';
import type { BootResult } from '../../../core/boot.ts';
import { defaultExitDeps, exitDevice, resetExitForTest, type ExitDeps } from '../../../core/device-exit.ts';
import { readReauth } from '../../../platform/auth-loss-store.ts';
import { querySessionFate, querySessionFateResult } from '../../../platform/supabase/session-fate.ts';
import type { ReauthDeps } from '../data/reauth.ts';
import { FATE_RETRY_BASE_MS, FATE_RETRY_CAP_MS, useReauth } from '../hooks/useReauth.ts';

const U = '00000000-0000-4000-8000-0000000000a1';
const S = '00000000-0000-4000-8000-0000000000c1';

/** 假服务器：按顺序回 200 + 这些词，回完以后一直回最后一个 */
function server(answers: string[]) {
  const left = [...answers];
  return vi.fn(async (_u: string, _i?: RequestInit) => {
    const v = left.length > 1 ? left.shift() : left[0];
    return new Response(JSON.stringify(v), { status: 200 });
  });
}
const conn = (f: ReturnType<typeof server>) => ({ fetch: f as unknown as typeof fetch, url: 'https://x.supabase.co', anonKey: 'anon', online: () => true });

/** 主 App 的退出依赖：resolveAuthLoss 走真的分类和 session_fate 解读，只把网络换成假服务器 */
function appDeps(boot: BootResult, f: ReturnType<typeof server>): ExitDeps {
  return {
    ...defaultExitDeps,
    getBoot: () => boot,
    wipe: vi.fn(async () => undefined),
    clearLocalSessionIf: vi.fn(async () => true),
    clearLogs: vi.fn(),
    broadcastReset: vi.fn(),
    goToAuth: vi.fn(),
    resolveAuthLoss: (signal) => resolveAuthLoss(signal, { fate: (s, u) => querySessionFate(s, u, conn(f)), record: () => undefined }),
  };
}

/**
 * 登录页的依赖：记号读真的 lemo.reauth，session_fate 走真的解读。
 * 算哈希（crypto.subtle）、读回包（res.json）是真的异步，假时钟管不到：last 记下最近一次查询，settle() 等它落定再拨时钟，
 * 免得机器忙时回包还没处理、下一次重查的定时器还没排上
 */
function loginDeps(f: ReturnType<typeof server>) {
  const wipe = vi.fn(async () => undefined);
  let last: Promise<unknown> = Promise.resolve();
  const d: ReauthDeps = {
    read: () => readReauth(),
    count: async () => 0,
    online: () => true,
    onOnline: () => () => undefined,
    fate: (s, u) => {
      const p = querySessionFateResult(s, u, conn(f));
      last = p;
      return p;
    },
    wipe,
    clearAuthLoss: () => undefined,
  };
  const settle = async (): Promise<void> => {
    await act(async () => {
      await last;
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  };
  return { d, wipe, settle };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetExitForTest();
  resetAuthLossForTest();
  localStorage.clear();
  sessionStorage.clear();
});

describe('session_fate 总闸打满（busy）', () => {
  it('解读：200 busy 是“稍后再查”（retry），不是定论 unknown；主 App 那一路当查不了（null）', async () => {
    expect(await querySessionFateResult(S, U, conn(server(['busy'])))).toBe('retry');
    expect(await querySessionFate(S, U, conn(server(['busy'])))).toBeNull();
    // 别的分支不变：unknown、revoked 原样
    expect(await querySessionFateResult(S, U, conn(server(['unknown'])))).toBe('unknown');
    expect(await querySessionFateResult(S, U, conn(server(['revoked'])))).toBe('revoked');
  });

  it('被移除时撞上 busy：主 App 先只退出、留着记号；登录页退避重查，查到 revoked 清库、提示被移除', async () => {
    const f = server(['busy', 'busy', 'busy', 'revoked']);
    const boot = { switching: false, userId: U } as BootResult;
    const app = appDeps(boot, f);
    await exitDevice({ reason: 'removed', sid: S, path: 'sync', code: 'refresh_token_not_found' }, app);
    expect(app.wipe).not.toHaveBeenCalled();
    expect(app.goToAuth).toHaveBeenCalledWith('expired', S);
    expect(readReauth()).toMatchObject({ user_id: U, session_id: S });   // 记号在，登录页才会接着查

    const { d, wipe, settle } = loginDeps(f);
    const { result } = renderHook(() => useReauth(d));
    await settle();
    expect(f).toHaveBeenCalledTimes(2);   // 登录页第一次：busy
    expect(wipe).not.toHaveBeenCalled();
    await advance(FATE_RETRY_BASE_MS);   // 30 秒后再查：busy
    await settle();
    expect(f).toHaveBeenCalledTimes(3);
    expect(wipe).not.toHaveBeenCalled();
    await advance(FATE_RETRY_BASE_MS * 2);   // 再 60 秒：revoked
    await settle();
    expect(f).toHaveBeenCalledTimes(4);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(result.current.view.kind).toBe('removed');
  });

  it('对照：真没吊销（unknown）照旧只退出，登录页查一次就停、不清库', async () => {
    const f = server(['unknown']);
    const boot = { switching: false, userId: U } as BootResult;
    const app = appDeps(boot, f);
    await exitDevice({ reason: 'removed', sid: S, path: 'sync', code: 'refresh_token_not_found' }, app);
    expect(app.wipe).not.toHaveBeenCalled();
    const { d, wipe, settle } = loginDeps(f);
    const { result } = renderHook(() => useReauth(d));
    await settle();
    await advance(FATE_RETRY_CAP_MS * 5);
    await settle();
    expect(f).toHaveBeenCalledTimes(2);
    expect(wipe).not.toHaveBeenCalled();
    expect(result.current.view.kind).toBe('expired');
  });

  it('服务器直接回 revoked：主 App 当场清库、提示被移除', async () => {
    const f = server(['revoked']);
    const boot = { switching: false, userId: U } as BootResult;
    const app = appDeps(boot, f);
    await exitDevice({ reason: 'removed', sid: S, path: 'sync', code: 'refresh_token_not_found' }, app);
    expect(app.wipe).toHaveBeenCalledTimes(1);
    expect(app.goToAuth).toHaveBeenCalledWith('removed', S);
  });
});
