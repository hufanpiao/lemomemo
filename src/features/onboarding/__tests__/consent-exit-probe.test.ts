// 告知页收到 account_disabled 先探测再定（R-256 ③、DISABLED-probe-later ①；consent-exit.ts 文件头）：
// record_consent 一路按 is_active() 判断，停用和冷静期都回 account_disabled；探测（platform/account-status.ts 的 exitForDisabled）以后
// pending_deletion → 冷静期提示；disabled → 已停用；removed（signed_out）→ 被移除；unknown → disabled_unsure；active → 不离开、留在告知页
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../../core/boot.ts';
import type { ExitNotice } from '../../../platform/session.ts';
import { defaultLeaveDeps, leaveThisDevice, resetLeaveForTest, type LeaveDeps } from '../data/consent-exit.ts';

function deps(answer: () => Promise<ExitNotice | 'active'>, boot: Partial<BootResult> | null = { switching: false, userId: 'U1' }) {
  const order: string[] = [];
  const d: LeaveDeps = {
    getBoot: () => boot as BootResult | null,
    wipe: vi.fn(async () => void order.push('wipe')),
    // 默认的 keep（expireThisTab）：账号 U1 不是 UUID，写不了记号，停用退回清库
    keep: defaultLeaveDeps.keep,
    clearLocalSessionIf: vi.fn(async (sid: string | null) => { order.push(`session:${sid ?? 'null'}`); return true; }),
    goToAuth: vi.fn((n: ExitNotice | null) => {
      if (n) order.push(`notice:${n}`);
      order.push('auth');
    }),
    resolveAuthLoss: vi.fn(async () => 'removed' as const),
    clearLogs: vi.fn(() => undefined),
    broadcastReset: vi.fn(),
    resolveDisabled: vi.fn(answer),
  };
  return { d, order };
}

afterEach(resetLeaveForTest);

describe('告知页 account_disabled：先探测再定退出原因', () => {
  for (const notice of ['pending_deletion', 'disabled', 'removed', 'disabled_unsure'] as const) {
    it(`探测结果 ${notice}：按它清本机、记原因、回登录页；探测用被拒那次的 sid`, async () => {
      const { d, order } = deps(async () => notice);
      await leaveThisDevice('account_disabled', 's1', d);
      expect(d.resolveDisabled).toHaveBeenCalledWith('s1');
      // 冷静期不删会话（R-262），清库、记原因、回登录页照旧
      expect(order).toEqual(
        notice === 'pending_deletion' ? ['wipe', `notice:${notice}`, 'auth'] : ['session:s1', 'wipe', 'session:s1', `notice:${notice}`, 'auth'],
      );
    });
  }

  it('探测完以前不删会话、不清本机（探测要用这个会话的令牌）', async () => {
    let answer = (_r: ExitNotice | 'active'): void => undefined;
    const { d, order } = deps(() => new Promise((r) => (answer = r)));
    const p = leaveThisDevice('account_disabled', 's1', d);
    await Promise.resolve();
    expect(order).toEqual([]);
    answer('pending_deletion');
    expect(await p).toBe(true);
    expect(order).toContain('notice:pending_deletion');
  });

  it('active（账号正常）：不清本机、不跳转；之后再遇到可以再处理（不被“只处理一次”挡住）', async () => {
    const { d, order } = deps(async () => 'active');
    expect(await leaveThisDevice('account_disabled', 's1', d)).toBe(false);   // 告知页据此提示“这一步没记下”（PROBE 遗留）
    expect(order).toEqual([]);
    await leaveThisDevice('session_revoked', 's1', d);
    expect(order).toContain('notice:removed');
    expect(d.goToAuth).toHaveBeenCalledOnce();
  });

  it('探测期间别的退出流程接手了（switching）：什么也不做', async () => {
    const boot = { switching: false, userId: 'U1' };
    let answer = (_r: ExitNotice | 'active'): void => undefined;
    const { d, order } = deps(() => new Promise((r) => (answer = r)), boot);
    const p = leaveThisDevice('account_disabled', 's1', d);
    boot.switching = true;
    answer('disabled');
    await p;
    expect(order).toEqual([]);
  });

  it('session_revoked 不探测，照旧直接按被移除走', async () => {
    const { d } = deps(async () => 'disabled');
    await leaveThisDevice('session_revoked', 's1', d);
    expect(d.resolveDisabled).not.toHaveBeenCalled();
    expect(d.goToAuth).toHaveBeenCalledWith('removed', 's1');
  });

  it('不给 resolveDisabled 时用 exitForDisabled：本机没有会话（拿不到令牌）→ 不探测，按 disabled_unsure', async () => {
    const { d } = deps(async () => 'disabled');
    delete d.resolveDisabled;
    sessionStorage.clear();
    localStorage.clear();
    await leaveThisDevice('account_disabled', 's1', d);
    expect(d.goToAuth).toHaveBeenCalledWith('disabled_unsure', 's1');
  });
});

describe('探测回 signed_out 也先查 session_fate（架构 4.1a 第 1 点；11-11 有意修改）', () => {
  const U = '00000000-0000-4000-8000-00000000000a';
  const S = '00000000-0000-4000-8000-0000000000c1';
  afterEach(() => localStorage.clear());
  for (const [fate, wiped, notice] of [['expired', false, 'expired'], ['removed', true, 'removed']] as const) {
    it(`真实账号（UUID，写得了记号）、session_fate 判 ${fate}：${wiped ? '清库' : '只退出不清库'}，提示 ${notice}`, async () => {
      const { d } = deps(async () => 'removed', { switching: false, userId: U });
      d.resolveAuthLoss = vi.fn(async () => fate);
      await leaveThisDevice('account_disabled', S, d);
      expect(d.resolveAuthLoss).toHaveBeenCalledWith(expect.objectContaining({ sessionId: S, userId: U }));
      expect(d.wipe).toHaveBeenCalledTimes(wiped ? 1 : 0);
      expect(d.goToAuth).toHaveBeenCalledWith(notice, S);
    });
  }
});

describe('探测期间再点一次（防重复，11-11 返修 ④）', () => {
  it('第一次还在探测时，第二次 account_disabled、session_revoked 都不再探测、不再离开', async () => {
    let answer = (_r: ExitNotice | 'active'): void => undefined;
    const { d } = deps(() => new Promise((r) => (answer = r)));
    const first = leaveThisDevice('account_disabled', 's1', d);
    expect(await leaveThisDevice('account_disabled', 's1', d)).toBe(true);
    expect(await leaveThisDevice('session_revoked', 's1', d)).toBe(true);
    expect(d.resolveDisabled).toHaveBeenCalledTimes(1);
    expect(d.goToAuth).not.toHaveBeenCalled();
    answer('pending_deletion');
    expect(await first).toBe(true);
    expect(d.goToAuth).toHaveBeenCalledOnce();
  });

  it('探测回 active 以后可以再点（不被防重复挡住）', async () => {
    const { d } = deps(async () => 'active');
    expect(await leaveThisDevice('account_disabled', 's1', d)).toBe(false);
    expect(await leaveThisDevice('account_disabled', 's1', d)).toBe(false);
    expect(d.resolveDisabled).toHaveBeenCalledTimes(2);
  });
});

describe('sid 读不出（null）时删会话（第八轮必改 1：不另认同账号）', () => {
  it('停用类退出也只用 clearLocalSessionIf(null)，前后两次', async () => {
    const { d, order } = deps(async () => 'disabled');
    await leaveThisDevice('account_disabled', null, d);
    expect(order.filter((x) => x.startsWith('session:'))).toEqual(['session:null', 'session:null']);
  });
});

describe('离开前广播带原因的 reset（SESS-1030-sugg ①，和设置页、sync-wiring 一致）', () => {
  function withPosts(answer: () => Promise<ExitNotice | 'active'>, boot: Partial<BootResult> | null = { switching: false, userId: 'U1' }) {
    const x = deps(answer, boot);
    x.d.broadcastReset = vi.fn((userId: string, e?: { notice: ExitNotice; sid: string | null }) => {
      x.order.push(e ? `post:${userId}:${e.notice}:${e.sid ?? 'null'}` : `post:${userId}`);
    });
    return x;
  }

  it('探测出冷静期：先发 reset {notice: pending_deletion, sid}，再清库、回登录页；清完库不发第二条（告知页原来就只发一条）；不删会话', async () => {
    const { d, order } = withPosts(async () => 'pending_deletion');
    await leaveThisDevice('account_disabled', 's1', d);
    expect(order).toEqual(['post:U1:pending_deletion:s1', 'wipe', 'notice:pending_deletion', 'auth']);
  });

  it('停用：删会话之前先发；被移除（先查服务器）定了结局再发；sid 为 null 时带 null', async () => {
    const a = withPosts(async () => 'disabled');
    await leaveThisDevice('account_disabled', 's1', a.d);
    expect(a.order).toEqual(['post:U1:disabled:s1', 'session:s1', 'wipe', 'session:s1', 'notice:disabled', 'auth']);
    resetLeaveForTest();
    const b = withPosts(async () => 'disabled');
    await leaveThisDevice('session_revoked', null, b.d);
    expect(b.order.slice(0, 2)).toEqual(['session:null', 'post:U1:removed:null']);
  });

  it('没启动过（没有 boot、读不到账号）：不发；active 不离开也不发；广播抛错照样离开', async () => {
    const a = withPosts(async () => 'pending_deletion', null);
    await leaveThisDevice('account_disabled', 's1', a.d);
    expect(a.d.broadcastReset).not.toHaveBeenCalled();
    expect(a.d.goToAuth).toHaveBeenCalledOnce();
    resetLeaveForTest();
    const b = withPosts(async () => 'active');
    await leaveThisDevice('account_disabled', 's1', b.d);
    expect(b.d.broadcastReset).not.toHaveBeenCalled();
    resetLeaveForTest();
    const c = withPosts(async () => 'pending_deletion');
    c.d.broadcastReset = vi.fn(() => {
      throw new Error('频道关了');
    });
    await leaveThisDevice('account_disabled', 's1', c.d);
    expect(c.d.goToAuth).toHaveBeenCalledOnce();
  });

  it('默认的 broadcastReset 真的往 lemo-sync:<user_id> 发 reset', async () => {
    const got: unknown[] = [];
    const ch = new BroadcastChannel('lemo-sync:U9');
    ch.onmessage = (e: MessageEvent) => void got.push(e.data);
    defaultLeaveDeps.broadcastReset('U9', { notice: 'pending_deletion', sid: 's1' });
    await vi.waitFor(() => expect(got).toEqual([{ type: 'reset', notice: 'pending_deletion', sid: 's1' }]));
    ch.close();
  });
});
