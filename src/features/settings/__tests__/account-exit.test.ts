// 注销成功、导出时发现停用或冷静期后离开本机（data/account-exit.ts；R-256 ⑤；架构 0.29 续第 131 条②；TC-B1-98 的客户端部分）
// 和被移除同一套（core/device-exit.ts）：清本机库（wipeLocal）→ 清日志队列 → 广播 reset → 只删发请求用的那个会话 → 回登录页带原因
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wipeLocal } from '../../../core/account.ts';
import type { BootResult } from '../../../core/boot.ts';
import { resetExitForTest } from '../../../core/device-exit.ts';
import { clearLocalSessionIf, readSessionUserId } from '../../../platform/session.ts';
import { createLeaveAccount, type AccountLeaveDeps } from '../data/account-exit.ts';

function deps(boot: Partial<BootResult> | null = { switching: false, userId: 'u1' }) {
  const order: string[] = [];
  const d = {
    getBoot: vi.fn(() => boot as BootResult | null),
    wipe: vi.fn(async (_b: BootResult) => void order.push('wipe')),
    // 默认 keep 是 expireThisTab：账号 u1 不是 UUID，写不了记号，停用退回清库
    keep: vi.fn((_b: BootResult, _n: string, _sid: string | null) => false),
    clearLogs: vi.fn((u: string | null) => void order.push(`logs:${u}`)),
    broadcastReset: vi.fn((u: string, exit?: { notice: string; sid: string | null }) =>
      void order.push(exit ? `reset:${u}:${exit.notice}:${exit.sid ?? 'null'}` : `reset:${u}`)),
    clearLocalSessionIf: vi.fn(async (sid: string | null) => { order.push(`session:${sid}`); return true; }),
    goToAuth: vi.fn((n: string | null, _sid: string | null) => void order.push(`auth:${n}`)),
    setNotice: vi.fn(),
    resolveAuthLoss: vi.fn(async () => 'removed' as const),
  } satisfies AccountLeaveDeps;
  return { d, order };
}

afterEach(resetExitForTest);

describe('createLeaveAccount', () => {
  it('R-382（负责人 11-11 定）已停用只退出、不清本机：keep 写记号、只关库 → 广播带 disabled 的 reset → 删那个会话 → 回登录页；不清库、不清日志', async () => {
    const { d, order } = deps();
    const keep = vi.fn(() => (order.push('expire'), true));
    await createLeaveAccount({ ...d, keep })('disabled', 's-me');
    expect(keep).toHaveBeenCalledWith(expect.anything(), 'disabled', 's-me');
    expect(order).toEqual(['expire', 'reset:u1:disabled:s-me', 'session:s-me', 'auth:disabled']);
    expect(d.wipe).not.toHaveBeenCalled();
  });

  it('顺序（已停用但写不了记号，退回原来的清库）：先广播带退出原因的 reset（DISABLED-probe-later ②）→ 删那个会话、清日志 → wipe（清库、缓存）→ 再清日志 → 广播 reset → 再删一次那个会话 → 回登录页', async () => {
    const { d, order } = deps();
    await createLeaveAccount(d)('disabled', 's-me');
    expect(order).toEqual([
      'reset:u1:disabled:s-me', 'session:s-me', 'logs:u1', 'wipe', 'logs:u1', 'reset:u1', 'session:s-me', 'auth:disabled',
    ]);
  });

  it('R-262：冷静期不删会话，其余顺序照旧；注销申请成功（revoked: true，服务器已吊销全部会话）照旧删', async () => {
    const a = deps();
    await createLeaveAccount(a.d)('pending_deletion', 's-me');
    expect(a.order).toEqual(['reset:u1:pending_deletion:s-me', 'logs:u1', 'wipe', 'logs:u1', 'reset:u1', 'auth:pending_deletion']);
    const b = deps();
    await createLeaveAccount(b.d)('pending_deletion', 's-me', { revoked: true });
    expect(b.order.filter((x) => x.startsWith('session:'))).toEqual(['session:s-me', 'session:s-me']);
  });

  it('停用时提示 disabled；只离开一次（再调不清第二遍）', async () => {
    const { d } = deps();
    const leave = createLeaveAccount(d);
    await leave('disabled', 's-me');
    await leave('pending_deletion', 's-me');
    expect(d.wipe).toHaveBeenCalledTimes(1);
    expect(d.goToAuth.mock.calls).toEqual([['disabled', 's-me']]);
  });

  it('已经在走别的退出流程（boot.switching）：什么也不做', async () => {
    const { d } = deps({ switching: true, userId: 'u1' });
    await createLeaveAccount(d)('pending_deletion', 's-me');
    expect(d.wipe).not.toHaveBeenCalled();
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
  });

  it('没启动过（没有 boot）：删会话、清全部日志队列、回登录页；不广播（不知道是哪个账号）', async () => {
    const { d, order } = deps(null);
    await createLeaveAccount(d)('disabled', 's-me');
    expect(order).toEqual(['session:s-me', 'logs:null', 'logs:null', 'session:s-me', 'auth:disabled']);
  });
});

describe('sid 读不出（null）时删会话（第八轮必改 1：不另认同账号）', () => {
  it('两次删会话都用 clearLocalSessionIf(null)', async () => {
    const { d } = deps();
    await createLeaveAccount(d)('disabled', null);
    expect(d.clearLocalSessionIf.mock.calls).toEqual([[null], [null]]);
  });
});

// SETTINGS-sugg ④：真的会话层（localStorage）和真的 wipeLocal
describe('真 localStorage、真 wipeLocal（SETTINGS-sugg ④）', () => {
  const KEY = 'sb-lemotest-auth-token';
  const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
  const seed = (sid: string, user: string): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));
  const U1 = '00000000-0000-4000-8000-0000000000a1';
  const U2 = '00000000-0000-4000-8000-0000000000b2';
  afterEach(() => localStorage.clear());

  /** clearAll：清库那几秒做什么 */
  function realDeps(clearAll: () => Promise<void>) {
    const cache = { name: 'lemo-test', isClosed: () => false, clearAll: vi.fn(clearAll), seal: vi.fn(), close: vi.fn() };
    const boot = { switching: false, userId: 'u1', cache, outbox: { suspend: vi.fn() } } as unknown as BootResult;
    const { d } = deps(boot);
    return {
      ...d,
      wipe: (b: BootResult) => wipeLocal(b, { clearCacheStorage: async () => undefined, deleteDb: async () => undefined, wipeMs: 50, cachesMs: 50 }),
      clearLocalSessionIf: vi.fn((sid: string | null) => clearLocalSessionIf(sid)),
    };
  }

  it('离开途中（清库那几秒）别的标签页登录了 B：结束后 B 的会话还在，被拒的 s-me 删掉', async () => {
    seed('s-me', U1);
    const d = realDeps(async () => seed('s-b', U2));
    await createLeaveAccount(d)('disabled', 's-me');
    expect(d.goToAuth).toHaveBeenCalledWith('disabled', 's-me');
    expect(readSessionUserId()).toBe(U2);
  });

  it('清库抛错：照样删会话、回登录页', async () => {
    seed('s-me', U1);
    const d = realDeps(async () => Promise.reject(new Error('InvalidStateError')));
    await createLeaveAccount(d)('disabled', 's-me');
    expect(d.goToAuth).toHaveBeenCalledWith('disabled', 's-me');
    expect(readSessionUserId()).toBeNull();
  });
});
