// 纪念日头像上传（data/avatar.ts 的 setAvatar；B5 整块评审第 5、6 条）：写行成功、上传失败时把 avatar_id、avatar_bytes 写回原来的值，
// 不留一个指向空对象的 avatar_id；每一步失败记一行运行日志（只记 anniv <步骤> <结果码>）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const savePatch = vi.fn<(t: string, id: string, d: Record<string, unknown>, r: boolean) => Promise<string>>();
const upload = vi.fn<() => Promise<{ ok: boolean; kind?: string; code?: string }>>();
const rlog = vi.fn<(line: string) => void>();
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: Parameters<typeof savePatch>) => savePatch(...a) }));
vi.mock('../../../platform/files.ts', () => ({ upload: () => upload() }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => rlog(l) }));
vi.mock('../../../core/boot.ts', () => ({ getBoot: () => ({ userId: 'u1', outbox: { list: async () => [], subscribe: () => () => undefined } }) }));
vi.mock('../data/avatar-view.ts', () => ({ avatarPath: () => 'p', seedAvatar: () => undefined }));

const { setAvatar } = await import('../data/avatar.ts');

const blob = new Blob([new Uint8Array(500)], { type: 'image/webp' });

beforeEach(() => {
  savePatch.mockReset().mockResolvedValue('saved');
  upload.mockReset();
  rlog.mockReset();
});

describe('setAvatar', () => {
  it('上传失败（不可重试）：avatar_id、avatar_bytes 写回原来的值，回 upload_failed，记 anniv avatar-upload', async () => {
    upload.mockResolvedValue({ ok: false, kind: 'denied', code: 'quota_exceeded' });
    expect(await setAvatar('a1', blob, { avatar_id: 'old', avatar_bytes: 300 })).toBe('upload_failed');
    expect(savePatch).toHaveBeenCalledTimes(2);
    expect(savePatch.mock.calls[1]?.[2]).toMatchObject({ avatar_id: 'old', avatar_bytes: 300 });
    expect(rlog.mock.calls.map((c) => c[0])).toEqual(['anniv avatar-upload denied:quota_exceeded']);
  });
  it('原来没头像：写回 null', async () => {
    upload.mockResolvedValue({ ok: false, kind: 'fatal' });
    await setAvatar('a1', blob, { avatar_id: null, avatar_bytes: null });
    expect(savePatch.mock.calls[1]?.[2]).toMatchObject({ avatar_id: null, avatar_bytes: null });
  });
  it('成功：只写一次，不记日志', async () => {
    upload.mockResolvedValue({ ok: true });
    expect(await setAvatar('a1', blob, { avatar_id: null, avatar_bytes: null })).toBe('ok');
    expect(savePatch).toHaveBeenCalledTimes(1);
    expect(rlog).not.toHaveBeenCalled();
  });
  it('写行失败：不上传，记 anniv avatar-write', async () => {
    savePatch.mockResolvedValue('failed');
    expect(await setAvatar('a1', blob, { avatar_id: null, avatar_bytes: null })).toBe('write_failed');
    expect(upload).not.toHaveBeenCalled();
    expect(rlog.mock.calls.map((c) => c[0])).toEqual(['anniv avatar-write failed']);
  });
});
