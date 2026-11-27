// platform/sign-out.ts 兜底删本机会话只删退出前那一个（接手清单 K6-sugg3 ①；sign-out.test.ts 已近 300 行，单独放）
// • signOutThisDevice 一开头读 session_id；④ 不是 ok 时 clearLocalSessionIf(那个 session_id)
// • 默认的几步（defaultExitSteps）：clearLocalSessionIf 走 session.ts 的 clearLocalSessionIf；没有“不给参数直接删”（K6-sugg4 ②，类型守着）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExitSteps, signOutThisDevice, type ExitSteps } from '../sign-out.ts';

const KEY = 'sb-lemotest-auth-token';
const put = (sid: string): void =>
  localStorage.setItem(KEY, JSON.stringify({ access_token: `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`, user: { id: 'u' } }));

afterEach(() => localStorage.clear());

describe('兜底只删退出前那一个会话（K6-sugg3 ①）', () => {
  it('signOutThisDevice：一开头读 session_id，不是 ok 时按它删', async () => {
    const s = {
      deleteDb: vi.fn(async () => undefined),
      clearCacheStorage: vi.fn(async () => undefined),
      clearLocalSessionIf: vi.fn(async (_sid: string | null) => true),
      readSessionId: vi.fn((): string | null => 's1'),
    } satisfies ExitSteps;
    await signOutThisDevice({ server: { signOut: async () => ({ serverDone: false }) }, steps: s, readUserId: () => 'u1', markSelf: () => undefined });
    expect(s.readSessionId).toHaveBeenCalledTimes(2);   // 一开头一次、④ 前再读一次（K6-signout-lib）
    expect(s.clearLocalSessionIf.mock.calls).toEqual([['s1']]);
  });

  it('默认实现：本机已经换成别的会话（s2）不删；还是那一个才删；null 只在本机没有会话时删', () => {
    put('s2');
    defaultExitSteps.clearLocalSessionIf('s1');
    expect(defaultExitSteps.readSessionId()).toBe('s2');
    defaultExitSteps.clearLocalSessionIf('s2');
    expect(localStorage.getItem(KEY)).toBeNull();
    put('s3');
    defaultExitSteps.clearLocalSessionIf(null);
    expect(defaultExitSteps.readSessionId()).toBe('s3');
  });
});

describe('兜底删会话的结果接进退出结果（A-1、A-M1）', () => {
  const steps = (ok: boolean | 'throw') => ({
    deleteDb: vi.fn(async () => undefined),
    clearCacheStorage: vi.fn(async () => undefined),
    clearLocalSessionIf: vi.fn(async (_sid: string | null) => {
      if (ok === 'throw') throw new Error('rust');
      return ok;
    }),
    readSessionId: (): string | null => 's1',
  }) satisfies ExitSteps;

  it('服务器没退成、兜底删失败（exe 里 Rust 删不掉）：localDone = false；删成了 true；抛错按失败', async () => {
    const run = (s: ExitSteps) => signOutThisDevice({ server: { signOut: async () => ({ serverDone: false }) }, steps: s, readUserId: () => 'u1', markSelf: () => undefined });
    await expect(run(steps(false))).resolves.toEqual({ serverDone: false, localDone: false });
    await expect(run(steps(true))).resolves.toEqual({ serverDone: false, localDone: true });
    await expect(run(steps('throw'))).resolves.toEqual({ serverDone: false, localDone: false });
  });

  it('exe 里服务器退成了也兜底删一次（显式删除、会写标记，安全复核追加建议）：会话已删时 clearLocalSessionIf 什么都不做、localDone = true；没删掉又删失败 localDone = false', async () => {
    const run = (s: ExitSteps) =>
      signOutThisDevice({ server: { signOut: async () => ({ serverDone: true }) }, steps: s, readUserId: () => 'u1', markSelf: () => undefined, inTauri: () => true });
    const ok = steps(true);
    await expect(run(ok)).resolves.toEqual({ serverDone: true, localDone: true });
    expect(ok.clearLocalSessionIf).toHaveBeenCalledExactlyOnceWith('s1');
    await expect(run(steps(false))).resolves.toEqual({ serverDone: true, localDone: false });
  });

  it('网页版服务器退成了：不兜底删（supabase-js 自己删），localDone = true', async () => {
    const s = steps(false);
    await expect(signOutThisDevice({ server: { signOut: async () => ({ serverDone: true }) }, steps: s, readUserId: () => 'u1', markSelf: () => undefined }))
      .resolves.toEqual({ serverDone: true, localDone: true });
    expect(s.clearLocalSessionIf).not.toHaveBeenCalled();
  });
});
