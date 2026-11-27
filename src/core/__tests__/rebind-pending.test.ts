// 交接结果不确定期间的退出闸（core/rebind-pending.ts；11-14 隐私记整块评审第 5 条）：
// S2 还在内存里时，别处收到 session_revoked 先把交接做完，换上了就不退出、不清库；交接被明确拒了才照常退出
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../boot.ts';
import { exitDevice, resetExitForTest, type ExitDeps } from '../device-exit.ts';
import { hasRebindRescue as rebindPending, setRebindRescue } from '../rebind-pending.ts';
import { createSessionRebind, type EphemeralAuth, type MainAuth } from '../session-rebind.ts';

const S1 = { access_token: 'old-access', refresh_token: 'old-refresh' };
const S2 = { access_token: 'new-access', refresh_token: 'new-refresh' };

function rebindWith(replies: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const main: MainAuth = { refreshSession: vi.fn(async () => ({ data: { session: S1 }, error: null })), setSession: vi.fn(async () => ({ error: null })) };
  const eph: EphemeralAuth = {
    signInWithOtp: vi.fn(async () => ({ error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session: S2 }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  const fetch = vi.fn(async () => (replies[Math.min(i++, replies.length - 1)] ?? (() => new Response('{}', { status: 500 })))());
  const r = createSessionRebind({ main: async () => main, ephemeral: async () => eph, fetch, accountUrl: 'https://x/a', anonKey: 'anon' });
  return { r, main, eph, fetch };
}

const net = () => Promise.reject(new TypeError('net'));

function exitDeps() {
  const boot = { userId: 'u1', sessionGone: false } as unknown as BootResult;
  const deps: ExitDeps = {
    getBoot: () => boot,
    wipe: vi.fn(async () => undefined),
    keep: vi.fn(() => true),
    clearLocalSessionIf: vi.fn(async () => true),
    clearLogs: vi.fn(),
    broadcastReset: vi.fn(),
    goToAuth: vi.fn(),
    resolveAuthLoss: vi.fn(async () => 'removed' as const),
  };
  return deps;
}

describe('交接结果不确定期间的退出闸', () => {
  afterEach(() => {
    setRebindRescue(null);
    resetExitForTest();
  });

  it('结果不确定：登记闸；之后收到 session_revoked → 先做完交接、换上 S2，不退出不清库；做完撤销登记', async () => {
    const { r, main } = rebindWith([net, net, net, () => new Response('{"ok":true}', { status: 200 })]);
    expect(await r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: false, error: 'offline' });
    expect(rebindPending()).toBe(true);
    const deps = exitDeps();
    await exitDevice({ reason: 'removed', sid: 's1', path: 'outbox' }, deps);
    expect(main.setSession).toHaveBeenCalledWith(S2);
    expect(deps.wipe).not.toHaveBeenCalled();
    expect(deps.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(deps.goToAuth).not.toHaveBeenCalled();
    expect(rebindPending()).toBe(false);
  });

  it('换上 S2 以后：先解开 outbox 的闸（草稿在 pagehide 时还能落盘），再整页重新载入（引擎、sync-wiring 已停，不会自己恢复）', async () => {
    const { r } = rebindWith([net, net, net, () => new Response('{"ok":true}', { status: 200 })]);
    await r.verifyAndRebind('a@b.c', '123456', 'dev-1');
    const deps = exitDeps();
    let gate = true;
    const order: string[] = [];
    const outbox = { suspend: vi.fn((on?: boolean) => ((gate = on !== false), order.push(`gate=${gate}`))), isSuspended: () => gate };
    Object.assign(deps.getBoot() as object, { outbox });
    deps.reload = vi.fn(() => void order.push('reload'));
    await exitDevice({ reason: 'removed', sid: 's1', path: 'outbox' }, deps);
    expect(order).toEqual(['gate=false', 'reload']);
    expect(deps.goToAuth).not.toHaveBeenCalled();
  });

  it('退出时交接被明确拒了：丢掉 S2，照常走被移除的退出', async () => {
    const { r, eph } = rebindWith([net, net, net, () => new Response('{"error":"rebind_failed"}', { status: 409 })]);
    await r.verifyAndRebind('a@b.c', '123456', 'dev-1');
    const deps = exitDeps();
    await exitDevice({ reason: 'removed', sid: 's1', path: 'outbox' }, deps);
    expect(eph.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(rebindPending()).toBe(false);
    expect(deps.clearLocalSessionIf).toHaveBeenCalledWith('s1');
    expect(deps.goToAuth).toHaveBeenCalled();
  });

  it('没有待换的 S2：不多等，照原来的顺序（同一个同步段里写记号、删会话）', () => {
    const deps = exitDeps();
    void exitDevice({ reason: 'removed', sid: 's1', path: 'outbox' }, deps);
    expect(deps.clearLocalSessionIf).toHaveBeenCalledWith('s1');
  });
});
