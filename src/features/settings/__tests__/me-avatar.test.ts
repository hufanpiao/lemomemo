// 设置里换我的头像（data/me-avatar.ts；R-384）：先写 profiles 两列再传；传不上把两列写回原值；额度满了回 quota_exceeded；
// 成功后先存进头像缓存、再把新 profile 交给 core/boot；运行日志只记 me avatar-<步骤> <结果码>
import { beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn<() => Promise<{ ok: boolean; kind?: string; code?: string }>>();
const seed = vi.fn(async () => undefined);
const fresh = vi.fn(async (..._a: unknown[]) => null);
const rlog = vi.fn<(l: string) => void>();
let profile: Record<string, unknown> = { id: 'u1', avatar_id: 'old', avatar_bytes: 300 };
vi.mock('../../../core/avatar-view.ts', () => ({ putAvatar: () => put(), meAvatarView: { seed: (...a: unknown[]) => seed(...(a as [])) } }));
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ userId: 'u1', profile }),
  applyFreshConfig: (...a: unknown[]) => fresh(...a),
}));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => rlog(l) }));

const { changeMeAvatar, clearMeAvatar } = await import('../data/me-avatar.ts');

const blob = new Blob([new Uint8Array(500)], { type: 'image/webp' });
const ok = { ok: true as const, value: undefined };

beforeEach(() => {
  put.mockReset();
  seed.mockClear();
  fresh.mockClear();
  rlog.mockReset();
  profile = { id: 'u1', avatar_id: 'old', avatar_bytes: 300 };
});

describe('changeMeAvatar', () => {
  it('成功：写一次两列（新 id、字节数），存缓存，交给 boot，日志只有 me avatar-change ok', async () => {
    put.mockResolvedValue({ ok: true });
    const saveAvatar = vi.fn(async () => ok);
    expect(await changeMeAvatar({ saveAvatar }, blob)).toBe('ok');
    expect(saveAvatar).toHaveBeenCalledTimes(1);
    const [id, bytes] = saveAvatar.mock.calls[0] as unknown as [string, number];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bytes).toBe(500);
    expect(seed).toHaveBeenCalledWith(id, blob);
    expect(fresh.mock.calls[0]?.[1]).toEqual({ profile: { id: 'u1', avatar_id: id, avatar_bytes: 500 } });
    expect(rlog.mock.calls.map((c) => c[0])).toEqual(['me avatar-change ok']);
  });

  it('上传失败：两列写回原值，回 upload_failed，不存缓存、不交给 boot；日志不带 id', async () => {
    put.mockResolvedValue({ ok: false, kind: 'retry', code: 'offline' });
    const saveAvatar = vi.fn(async () => ok);
    expect(await changeMeAvatar({ saveAvatar }, blob)).toEqual({ result: 'upload_failed' });
    expect(saveAvatar.mock.calls[1]).toEqual(['old', 300]);
    expect(seed).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(rlog.mock.calls.map((c) => c[0])).toEqual(['me avatar-upload retry:offline']);
  });

  it('原来没头像、上传被额度拒：写回 null，回 quota_exceeded', async () => {
    profile = { id: 'u1' };
    put.mockResolvedValue({ ok: false, kind: 'denied', code: 'quota_exceeded' });
    const saveAvatar = vi.fn(async () => ok);
    expect(await changeMeAvatar({ saveAvatar }, blob)).toEqual({ result: 'quota_exceeded' });
    expect(saveAvatar.mock.calls[1]).toEqual([null, null]);
  });

  it('写行被额度触发器拒：不上传，回 quota_exceeded；断网回 offline', async () => {
    const q = vi.fn(async () => ({ ok: false as const, error: 'quota_exceeded' as const }));
    expect(await changeMeAvatar({ saveAvatar: q }, blob)).toMatchObject({ result: 'quota_exceeded' });
    const off = vi.fn(async () => ({ ok: false as const, error: 'offline' as const }));
    expect(await changeMeAvatar({ saveAvatar: off }, blob)).toMatchObject({ result: 'offline' });
    expect(put).not.toHaveBeenCalled();
    expect(rlog.mock.calls.map((c) => c[0])).toEqual(['me avatar-write quota_exceeded', 'me avatar-write offline']);
  });
});

describe('clearMeAvatar', () => {
  it('两列写 null、交给 boot', async () => {
    const saveAvatar = vi.fn(async () => ok);
    expect(await clearMeAvatar({ saveAvatar })).toBe('ok');
    expect(saveAvatar).toHaveBeenCalledWith(null, null);
    expect(fresh.mock.calls[0]?.[1]).toEqual({ profile: { id: 'u1', avatar_id: null, avatar_bytes: null } });
  });
});
