// platform/view-fetch.ts：images 桶“签名 → 取字节”头像、插图共用的一份（改善报告 11-20 二-4）：
// 同一轮攒成一次签名；签名过期重签一次；还过期、not_found、没签上、签名请求整个失败都回取不到，带 why（只有步骤和结果码）
import { describe, expect, it, vi } from 'vitest';
import type { BlobResult, SignResult } from '../files.ts';
import { createViewFetch } from '../view-fetch.ts';

const okSign = (path: string): SignResult => ({ ok: true, url: `https://x/files/v1/o/images/${path}`, sig: 's', expiresAt: 1 });
const err = (kind: 'resign' | 'denied' | 'retry', code: string, reason?: string) => ({ ok: false as const, kind, code, status: 403, ...(reason ? { reason } : {}) });
const blob = (): BlobResult => ({ ok: true, blob: new Blob([new Uint8Array(2)]), contentType: 'image/webp' });

describe('createViewFetch', () => {
  it('同一轮的路径攒成一次签名（用途 view、images 桶）；各自取字节', async () => {
    const sign = vi.fn((items: readonly { path: string }[]) => Promise.resolve(items.map((x) => okSign(x.path))));
    const fetchBlob = vi.fn(() => Promise.resolve(blob()));
    const get = createViewFetch({ sign, fetchBlob });
    const [a, b] = await Promise.all([get('u/a.webp'), get('u/b.webp')]);
    expect(a.ok && b.ok).toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0]?.[0]).toEqual([
      { bucket: 'images', path: 'u/a.webp', purpose: 'view' },
      { bucket: 'images', path: 'u/b.webp', purpose: 'view' },
    ]);
    expect(fetchBlob).toHaveBeenCalledTimes(2);
  });

  it('签名过期（resign）：只为这一张重签一次再取，拿到图', async () => {
    const sign = vi.fn((items: readonly { path: string }[]) => Promise.resolve(items.map((x) => okSign(x.path))));
    const fetchBlob = vi.fn().mockResolvedValueOnce(err('resign', 'expired')).mockResolvedValueOnce(blob());
    const r = await createViewFetch({ sign, fetchBlob })('u/a.webp');
    expect(r.ok).toBe(true);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1]?.[0]).toEqual([{ bucket: 'images', path: 'u/a.webp', purpose: 'view' }]);
  });

  it('重签以后还过期：不再签第三次，回取不到（why 带结果码）', async () => {
    const sign = vi.fn((items: readonly { path: string }[]) => Promise.resolve(items.map((x) => okSign(x.path))));
    const fetchBlob = vi.fn().mockResolvedValue(err('resign', 'bad_signature'));
    expect(await createViewFetch({ sign, fetchBlob })('u/a.webp')).toEqual({ ok: false, missing: false, why: 'fetch resign:bad_signature' });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('图不在（取字节 not_found、签名 no_row）报 missing；没签上、签名请求整个失败、取字节抛错都是取不到', async () => {
    const fetchBlob = vi.fn().mockResolvedValue(err('denied', 'not_found'));
    expect(await createViewFetch({ sign: (it) => Promise.resolve(it.map((x) => okSign(x.path))), fetchBlob })('a')).toEqual({ ok: false, missing: true, why: 'fetch denied:not_found' });
    expect(await createViewFetch({ sign: () => Promise.resolve([err('denied', 'forbidden', 'no_row')]), fetchBlob })('a')).toEqual({ ok: false, missing: true, why: 'sign denied:forbidden' });
    expect(await createViewFetch({ sign: () => Promise.resolve([{ ok: true, url: 'u', sig: null, expiresAt: 1 }]), fetchBlob })('a')).toEqual({ ok: false, missing: false, why: 'sign no_sig' });
    expect(await createViewFetch({ sign: () => Promise.reject(new Error('x')), fetchBlob })('a')).toEqual({ ok: false, missing: false, why: 'sign failed' });
    expect(await createViewFetch({ sign: (it) => Promise.resolve(it.map((x) => okSign(x.path))), fetchBlob: () => Promise.reject(new Error('x')) })('a')).toEqual({ ok: false, missing: false, why: 'fetch failed' });
  });
});
