// 安全审查必改 1（B2-安全审查-推送断开按需下载.md）：默认路径上的 push.ts 一直下载不回（没成功也没报错，比如没有 SW 时网络被挂住）时，
// 退出（signOutThisDevice 照常走到 ④ signOut、⑤ 删库）按时完成，不卡住；换账号那条在 core/__tests__/account-push-hang.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// 下载永远不回
vi.mock('../push.ts', () => new Promise(() => undefined));

const { DISCONNECT_PUSH_MS } = await import('../push-claim-key.ts');
const { disconnectPushLazy, setPushDisconnectLog } = await import('../push-disconnect.ts');
const { signOutThisDevice } = await import('../sign-out.ts');

afterEach(() => {
  vi.useRealTimers();
  setPushDisconnectLog(null);
});

describe('push.ts 一直下载不回', () => {
  it('退出这台设备：最多多等 DISCONNECT_PUSH_MS，④ signOut、⑤ 删库照常执行，记 timeout', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    setPushDisconnectLog((code) => void logs.push(code));
    const log: string[] = [];
    let done = false;
    const p = signOutThisDevice({
      server: { deleteOwnDevice: async () => void log.push('row'), signOut: async () => (log.push('signout'), { serverDone: true }) },
      steps: {
        disconnectPush: () => disconnectPushLazy(),
        deleteDb: async () => void log.push('deleteDb'),
        clearCacheStorage: async () => void log.push('caches'),
        clearLocalSessionIf: async () => (log.push('session'), true),
        readSessionId: () => 's1',
      },
      readUserId: () => 'u1',
    }).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(DISCONNECT_PUSH_MS);
    expect(done).toBe(true);
    expect(await p).toMatchObject({ serverDone: true });
    expect(log).toEqual(['row', 'deleteDb', 'caches', 'signout', 'deleteDb']);
    expect(logs[0]).toBe('timeout');
  });
});
