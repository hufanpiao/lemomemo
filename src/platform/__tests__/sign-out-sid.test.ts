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
      clearLocalSessionIf: vi.fn((_sid: string | null): void => undefined),
      readSessionId: vi.fn((): string | null => 's1'),
    } satisfies ExitSteps;
    await signOutThisDevice({ server: { signOut: async () => ({ serverDone: false }) }, steps: s, readUserId: () => 'u1', markSelf: () => undefined });
    expect(s.readSessionId).toHaveBeenCalledTimes(1);
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
