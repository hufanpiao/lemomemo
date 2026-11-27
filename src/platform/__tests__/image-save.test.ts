// 看图页“存到相册”（台账 #383；platform/image-save.ts）：认图片类型、起文件名、手机交分享面板 / 分享不了退回下载 / 电脑下载。
// 分享面板里点“存储图像”真的进了 iPhone 相册，这里测不到，只能真机验
import { describe, expect, it, vi } from 'vitest';
import { blobOfUrl, makeBlobUrl, revokeBlobUrl } from '../blob-url.ts';
import type { SaveEnv } from '../save-file.ts';
import { idTime, imageFileName, prepareImage, saveImage, sniffImage } from '../image-save.ts';

const bytes = (...xs: (number | string)[]): Uint8Array<ArrayBuffer> => {
  const out: number[] = [];
  for (const x of xs) {
    if (typeof x === 'number') out.push(x);
    else for (const c of x) out.push(c.charCodeAt(0));
  }
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
};

describe('sniffImage：只看字节头', () => {
  it('JPEG、PNG、WebP、GIF、HEIC、HEIF；认不出按 webp', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(bytes('RIFF', 1, 2, 3, 4, 'WEBP'))).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(sniffImage(bytes('GIF89a'))).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(sniffImage(bytes(0, 0, 0, 0x18, 'ftypheic'))).toEqual({ mime: 'image/heic', ext: 'heic' });
    expect(sniffImage(bytes(0, 0, 0, 0x18, 'ftypmif1'))).toEqual({ mime: 'image/heif', ext: 'heif' });
    expect(sniffImage(bytes('hello'))).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(sniffImage(new Uint8Array(0))).toEqual({ mime: 'image/webp', ext: 'webp' });
  });
});

describe('文件名', () => {
  // 2026-11-22 15:30:12 首尔 = 06:30:12 UTC
  const MS = Date.UTC(2026, 10, 22, 6, 30, 12);
  const hex = MS.toString(16).padStart(12, '0');
  const V7 = `${hex.slice(0, 8)}-${hex.slice(8)}-7abc-8000-000000000001`;

  it('uuidv7 读出插入时间；不是 v7 回 null', () => {
    expect(idTime(V7)).toBe(MS);
    expect(idTime('0199a000-0000-4000-8000-000000000001')).toBeNull();
    expect(idTime('x')).toBeNull();
  });

  it('IMG_年月日_时分秒，按时区的墙上时间；时间不明只写 IMG', () => {
    expect(imageFileName(MS, 'webp', 'Asia/Seoul')).toBe('IMG_20261122_153012.webp');
    expect(imageFileName(MS, 'jpg', 'UTC')).toBe('IMG_20261122_063012.jpg');
    expect(imageFileName(null, 'png', 'Asia/Seoul')).toBe('IMG.png');
    expect(imageFileName(MS, 'png', 'Not/AZone')).toBe('IMG.png');
  });

  it('prepareImage：拍摄时间优先，没有（隐私记）用 id 里的插入时间；类型按字节改标', async () => {
    const webp = new Blob([bytes('RIFF', 1, 2, 3, 4, 'WEBP')], { type: '' });
    const get = vi.fn(() => webp);
    const shot = Date.UTC(2025, 0, 2, 3, 4, 5);
    const a = await prepareImage('blob:x', { id: V7, takenAt: shot }, 'UTC', get);
    expect(a?.name).toBe('IMG_20250102_030405.webp');
    expect(a?.type).toBe('image/webp');
    expect(a?.blob.type).toBe('image/webp');
    const b = await prepareImage('blob:x', { id: V7 }, 'Asia/Seoul', get);
    expect(b?.name).toBe('IMG_20261122_153012.webp');
    expect(get).toHaveBeenCalledWith('blob:x');
  });

  it('地址已撤、不是 blob-url.ts 造的：回 null（不抛）', async () => {
    expect(await prepareImage('blob:x', { id: V7 }, 'UTC', () => null)).toBeNull();
    expect(await prepareImage('blob:nope', { id: V7 }, 'UTC')).toBeNull();
  });

  it('blob-url.ts 造的地址拿回原 Blob；撤了就没有', async () => {
    const b = new Blob([bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)], { type: 'image/png' });
    const u = makeBlobUrl(b);
    expect(blobOfUrl(u)).toBe(b);
    const p = await prepareImage(u, { id: V7 }, 'UTC');
    expect(p?.blob).toBe(b);
    expect(p?.name).toBe('IMG_20261122_063012.png');
    revokeBlobUrl(u);
    expect(blobOfUrl(u)).toBeNull();
  });
});

describe('saveImage', () => {
  const file = { blob: new Blob(['x'], { type: 'image/webp' }), name: 'IMG_20261122_153012.webp', type: 'image/webp' };
  const env = (over: Partial<SaveEnv> = {}) => ({
    isIosStandalone: vi.fn(() => false),
    share: vi.fn(async (_d: { files: File[] }) => undefined),
    canShare: vi.fn((_d: { files: File[] }) => true),
    download: vi.fn((_b: Blob, _n: string, _ms?: number) => undefined),
    ...over,
  });

  it('手机：交给分享面板，文件名和类型带过去，不下载', async () => {
    const share = vi.fn(async (_d: { files: File[] }) => undefined);
    const e = env({ share });
    expect(await saveImage(file, true, e)).toBe('shared');
    const f = share.mock.calls[0]?.[0].files[0];
    expect(f?.name).toBe(file.name);
    expect(f?.type).toBe('image/webp');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('手机：分享不了文件（没有 share 或 canShare 不认）退回下载', async () => {
    const e = env({ canShare: vi.fn(() => false) });
    expect(await saveImage(file, true, e)).toBe('downloaded');
    expect(e.download).toHaveBeenCalledWith(file.blob, file.name, 10_000);
  });

  it('手机：面板里取消 → cancelled；被拒 → needs_tap；都不下载', async () => {
    const abort = env({ share: vi.fn(async () => Promise.reject(Object.assign(new Error('a'), { name: 'AbortError' }))) });
    expect(await saveImage(file, true, abort)).toBe('cancelled');
    const deny = env({ share: vi.fn(async () => Promise.reject(Object.assign(new Error('n'), { name: 'NotAllowedError' }))) });
    expect(await saveImage(file, true, deny)).toBe('needs_tap');
    expect(abort.download).not.toHaveBeenCalled();
    expect(deny.download).not.toHaveBeenCalled();
  });

  it('电脑：直接下载，不弹分享面板', async () => {
    const e = env();
    expect(await saveImage(file, false, e)).toBe('downloaded');
    expect(e.share).not.toHaveBeenCalled();
    expect(e.download).toHaveBeenCalledTimes(1);
  });
});
