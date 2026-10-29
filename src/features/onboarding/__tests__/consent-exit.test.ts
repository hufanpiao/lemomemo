// 告知页里会话不认、账号停用时离开这台设备（CONSENT-wire ④；架构 4.1、4.3 ②）：调现有出口 wipeOnRemoved，清完记退出原因、删会话、回登录页；
// 原因按码：session_revoked → removed，account_disabled → disabled；已经在走别的退出流程（switching）不再走；只处理一次；
// 这个账号的日志上传队列清库前清一次、回登录页前再清一次（0.38 第 68 条 ⑤，审查 M1），没启动过时清全部；
// 本机会话一开头就删，回登录页前只在还是那一个时再删（K6-sugg3 ①）
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import { logQueueKey } from '../../../platform/log-store.ts';
import { readSessionUserId } from '../../../platform/session.ts';
import { defaultLeaveDeps, leaveThisDevice, resetLeaveForTest, type LeaveDeps } from '../data/consent-exit.ts';

function deps(boot: Partial<BootResult> | null) {
  const order: string[] = [];
  const d: LeaveDeps = {
    getBoot: () => boot as BootResult | null,
    wipeOnRemoved: vi.fn(async (_b: BootResult, r: { clearCacheStorage(): Promise<void>; onRemoved(): void }) => {
      order.push('wipe');
      await r.clearCacheStorage();
      r.onRemoved();
    }),
    clearCacheStorage: vi.fn(async () => {
      order.push('caches');
    }),
    setExitNotice: vi.fn((n) => {
      order.push(`notice:${n}`);
    }),
    takeLocalSession: vi.fn(() => {
      order.push('take');
      return 's1';
    }),
    clearLocalSessionIf: vi.fn((sid: string | null) => {
      order.push(`session:${sid ?? 'null'}`);
    }),
    goToAuth: vi.fn(() => {
      order.push('auth');
    }),
    clearLogs: vi.fn((userId: string | null) => {
      order.push(`logs:${userId ?? '*'}`);
    }),
  };
  return { d, order };
}

afterEach(resetLeaveForTest);

describe('leaveThisDevice', () => {
  it('会话不认：清本机（wipeOnRemoved）→ 记 removed → 删会话 → 回登录页', async () => {
    const { d, order } = deps({ switching: false, userId: 'U1' });
    await leaveThisDevice('session_revoked', d);
    expect(order).toEqual(['take', 'logs:U1', 'wipe', 'caches', 'logs:U1', 'notice:removed', 'session:s1', 'auth']);
  });

  it('账号停用：同一套，退出原因记 disabled（登录页 auth.exit.disabled）', async () => {
    const { d, order } = deps({ switching: false, userId: 'U1' });
    await leaveThisDevice('account_disabled', d);
    expect(order).toEqual(['take', 'logs:U1', 'wipe', 'caches', 'logs:U1', 'notice:disabled', 'session:s1', 'auth']);
  });

  it('没启动过（没有 boot）：不清库，直接记原因、删会话、回登录页', async () => {
    const { d, order } = deps(null);
    await leaveThisDevice('account_disabled', d);
    expect(order).toEqual(['take', 'logs:*', 'logs:*', 'notice:disabled', 'session:s1', 'auth']);
    expect(d.wipeOnRemoved).not.toHaveBeenCalled();
  });

  it('已经在走别的退出流程（switching）：什么也不做', async () => {
    const { d, order } = deps({ switching: true });
    await leaveThisDevice('session_revoked', d);
    expect(order).toEqual([]);
  });

  it('只处理一次：连着来两次只清一遍、只跳一次', async () => {
    const { d } = deps({ switching: false, userId: 'U1' });
    await Promise.all([leaveThisDevice('session_revoked', d), leaveThisDevice('account_disabled', d)]);
    expect(d.wipeOnRemoved).toHaveBeenCalledOnce();
    expect(d.goToAuth).toHaveBeenCalledOnce();
    expect(d.setExitNotice).toHaveBeenCalledWith('removed');
  });

  it('默认的 clearLogs 真的删掉 localStorage 里的队列：有账号只删这个账号的，null 删全部 lemo.logq.*', () => {
    localStorage.setItem(logQueueKey('U1'), '[]');
    localStorage.setItem(logQueueKey('U2'), '[]');
    localStorage.setItem('other', 'x');
    defaultLeaveDeps.clearLogs('U1');
    expect(localStorage.getItem(logQueueKey('U1'))).toBeNull();
    expect(localStorage.getItem(logQueueKey('U2'))).toBe('[]');
    defaultLeaveDeps.clearLogs(null);
    expect(localStorage.getItem(logQueueKey('U2'))).toBeNull();
    expect(localStorage.getItem('other')).toBe('x');
    localStorage.removeItem('other');
  });

  describe('删本机会话的时机（K6-sugg3 ①，默认的 takeLocalSession / clearLocalSessionIf 读写真的 localStorage）', () => {
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const KEY = 'sb-lemotest-auth-token';
    const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
    const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));
    afterEach(() => localStorage.clear());

    /** wipeOnRemoved 卡在 gate 上（= 清库那几秒）；会话两步用默认的 */
    function gated() {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const { d } = deps({ switching: false, userId: A });
      d.takeLocalSession = defaultLeaveDeps.takeLocalSession;
      d.clearLocalSessionIf = defaultLeaveDeps.clearLocalSessionIf;
      d.wipeOnRemoved = vi.fn(async (_b: BootResult, r: { onRemoved(): void }) => {
        await gate;
        r.onRemoved();
      });
      return { d, release };
    }

    for (const [label, sid, user] of [['别的账号', 's2', B], ['同一账号的新会话', 's2', A]] as const) {
      it(`一开头就删；清库期间别的标签页登录了${label}：回登录页时不删`, async () => {
        seed('s1');
        const { d, release } = gated();
        const p = leaveThisDevice('session_revoked', d);
        expect(readSessionUserId()).toBeNull();   // 同步删掉了
        seed(sid, user);
        release();
        await p;
        expect(d.goToAuth).toHaveBeenCalledOnce();
        expect(readSessionUserId()).toBe(user);
      });
    }

    it('旧会话 s1 被晚到的令牌刷新写回：回登录页前再删一次', async () => {
      seed('s1');
      const { d, release } = gated();
      const p = leaveThisDevice('account_disabled', d);
      seed('s1');
      release();
      await p;
      expect(readSessionUserId()).toBeNull();
    });
  });
});
