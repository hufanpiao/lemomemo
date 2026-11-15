// 我的头像（kit 的 useMeAvatar / MeAvatar；R-384）：profile 里有 avatar_id 时先读 Cache Storage，读到就直接显示、不加载 core/avatar-view；
// 读不到才（首屏画完后）加载 core/avatar-view 去取；profile 变了（applyFreshConfig 通知）跟着换；没头像显示名字首字
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let profile: Record<string, unknown> | null = null;
const subs = new Set<() => void>();
const cached = new Map<string, Blob>();
const load = vi.fn(async () => 'blob:net');
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ userId: 'u1', profile }),
  subscribeProfile: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)),
}));
vi.mock('../../../core/avatar-cache.ts', () => ({
  ME_AVATAR: { cache: 'c', keyPrefix: 'k', tag: 'me' },
  meAvatarPath: (u: string, id: string) => `${u}/me/${id}.webp`,
  meAvatarId: (p: Record<string, unknown> | null) => (typeof p?.['avatar_id'] === 'string' ? p['avatar_id'] : null),
  readCachedAvatar: async (_s: unknown, id: string) => cached.get(id) ?? null,
  dropCachedAvatar: (_s: unknown, id: string) => void cached.delete(id),
}));
vi.mock('../../../core/avatar-view.ts', () => ({ meAvatarView: { load: (...a: unknown[]) => load(...(a as [])) } }));
vi.mock('../../../platform/root-paint.ts', () => ({ appPainted: async () => undefined }));

const { MeAvatar } = await import('../../components/MeAvatar.tsx');
const { resetMeAvatarForTest } = await import('../useMeAvatar.ts');

const ping = (): void => {
  for (const f of [...subs]) f();
};

beforeEach(() => {
  profile = { id: 'u1', display_name: '王小明' };
  subs.clear();
  cached.clear();
  load.mockClear();
  resetMeAvatarForTest();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cache');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MeAvatar', () => {
  it('没头像：名字首字，不取图', () => {
    render(<MeAvatar testId="me" />);
    expect(screen.getByTestId('me').textContent).toBe('王');
    expect(screen.getByTestId('me').hasAttribute('data-has-img')).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('缓存里有：直接显示，不加载 core/avatar-view', async () => {
    profile = { id: 'u1', avatar_id: 'a1' };
    cached.set('a1', new Blob([new Uint8Array(3)]));
    render(<MeAvatar testId="me" />);
    await waitFor(() => expect(screen.getByTestId('me').hasAttribute('data-has-img')).toBe(true));
    expect(load).not.toHaveBeenCalled();
  });

  it('缓存里没有：经 core/avatar-view 取；profile 去掉头像后变回首字', async () => {
    profile = { id: 'u1', display_name: 'Kim', avatar_id: 'a2' };
    render(<MeAvatar testId="me" />);
    await waitFor(() => expect(screen.getByTestId('me').hasAttribute('data-has-img')).toBe(true));
    expect(load).toHaveBeenCalledWith('u1/me/a2.webp');
    profile = { id: 'u1', display_name: 'Kim', avatar_id: null };
    act(ping);
    expect(screen.getByTestId('me').textContent).toBe('K');
  });

  it('两处同时挂只取一次', async () => {
    profile = { id: 'u1', avatar_id: 'a3' };
    render(
      <>
        <MeAvatar testId="x" />
        <MeAvatar testId="y" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('y').hasAttribute('data-has-img')).toBe(true));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
