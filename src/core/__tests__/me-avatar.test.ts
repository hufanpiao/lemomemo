// 我的头像的回滚补写（core/me-avatar.ts；R-384 整块评审第 2 条）：两列改回原值没写成就记进本机 meta，以后每次 profile 通知
// （applyFreshConfig：启动、回到前台的同步轮）再试；写的时候带条件 avatar_id = 没传上的那一个；写成了删掉待办，本机拉到的坏 id 也改回去
import { beforeEach, describe, expect, it, vi } from 'vitest';

const meta = new Map<string, unknown>();
const subs = new Set<() => void>();
let profile: Record<string, unknown> = { id: 'u1', avatar_id: 'old', avatar_bytes: 300 };
const fresh = vi.fn(async (_b: unknown, f: { profile: Record<string, unknown> }) => {
  profile = f.profile;
  return null;
});
const cache = {
  isClosed: () => false,
  getMeta: async (k: string) => meta.get(k),
  setMeta: async (k: string, v: unknown) => void meta.set(k, v),
  deleteMeta: async (k: string) => void meta.delete(k),
};
vi.mock('../boot.ts', () => ({
  getBoot: () => ({ userId: 'u1', profile, cache }),
  subscribeProfile: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)),
  applyFreshConfig: (b: unknown, f: { profile: Record<string, unknown> }) => fresh(b, f),
}));
vi.mock('../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));
const calls: unknown[][] = [];
let fail = true;
vi.mock('../../platform/supabase/client.ts', () => ({
  getSupabase: async () => ({
    from: (t: string) => ({
      update: (v: unknown) => ({
        eq: (c1: string, v1: string) => ({
          eq: async (c2: string, v2: string) => {
            calls.push([t, v, c1, v1, c2, v2]);
            return { error: fail ? { message: 'Failed to fetch' } : null };
          },
        }),
      }),
    }),
  }),
}));

const { meAvatarStore, undoMeAvatar } = await import('../me-avatar.ts');
const U = { bad: 'bad', id: 'old', bytes: 300 };
const ping = async (): Promise<void> => {
  for (const f of [...subs]) f();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  meta.clear();
  calls.length = 0;
  fresh.mockClear();
  fail = true;
  profile = { id: 'u1', avatar_id: 'old', avatar_bytes: 300 };
});

describe('undoMeAvatar', () => {
  it('写成：带条件 avatar_id = 没传上的那一个，不留待办', async () => {
    fail = false;
    expect(await undoMeAvatar(U)).toBe(true);
    expect(calls).toEqual([['profiles', { avatar_id: 'old', avatar_bytes: 300 }, 'user_id', 'u1', 'avatar_id', 'bad']]);
    expect(meta.has('me_avatar_undo')).toBe(false);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('没写成：记进 meta；之后 profile 通知时再试，写成了删掉待办，本机拉到的坏 id 也改回去', async () => {
    expect(await undoMeAvatar(U)).toBe(false);
    expect(meta.get('me_avatar_undo')).toEqual(U);
    meAvatarStore.subscribe(() => undefined);   // 仓第一次用到：订阅 profile，并当场试一次
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(meta.has('me_avatar_undo')).toBe(true);
    fail = false;
    profile = { id: 'u1', avatar_id: 'bad', avatar_bytes: 500 };   // 同步轮把服务器上的坏 id 拉回来了
    await ping();
    await vi.waitFor(() => expect(meta.has('me_avatar_undo')).toBe(false));
    expect(calls).toHaveLength(3);
    expect(profile).toEqual({ id: 'u1', avatar_id: 'old', avatar_bytes: 300 });
    await ping();
    expect(calls).toHaveLength(3);
  });
});
