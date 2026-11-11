// R-382 安全审建议 2：本人退出（signOutThisDevice）发第一个服务器请求之前就删掉 lemo.reauth 和 lemo.authloss——
// 删行、signOut 引起的 SIGNED_OUT 或中途关页，都不会把本人退出当成“登录过期”留下本机库
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signOutThisDevice, type ExitSteps } from '../sign-out.ts';

afterEach(() => localStorage.clear());

function steps(): ExitSteps {
  return {
    deleteDb: vi.fn(async () => undefined),
    clearCacheStorage: vi.fn(async () => undefined),
    clearLocalSessionIf: vi.fn(async () => true),
    readSessionId: vi.fn((): string | null => 's1'),
  };
}

describe('本人退出先删记号', () => {
  it('删行（第一个服务器请求）开始时 lemo.reauth、lemo.authloss 都已删掉', async () => {
    localStorage.setItem('lemo.reauth', '{"v":1}');
    localStorage.setItem('lemo.authloss', '[]');
    let atRow: (string | null)[] = [];
    await signOutThisDevice({
      server: {
        deleteOwnDevice: async () => {
          atRow = [localStorage.getItem('lemo.reauth'), localStorage.getItem('lemo.authloss')];
        },
        signOut: async () => ({ serverDone: true }),
      },
      steps: steps(),
      readUserId: () => 'u1',
      markSelf: () => undefined,
    });
    expect(atRow).toEqual([null, null]);
  });
});
