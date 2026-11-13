// 纪念日头像取图（data/avatar-view.ts；B5 整块评审第 16 条、架构 5.4）：取回来的字节按 avatar_id 存进 Cache Storage，
// 下次（重开 App 也一样）先读缓存、不再签名取图；本机刚传的那一张也存；不再用的删掉；缓存打不开照常走网络
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sign = vi.fn();
const fetchBlob = vi.fn();
let rows: { id: string; avatar_id?: unknown; deleted_at?: unknown }[] = [];
const subs = new Set<() => void>();
vi.mock('../../../platform/files.ts', () => ({ SIGN_BATCH_MAX: 100, sign: (...a: unknown[]) => sign(...a), fetchBlob: (...a: unknown[]) => fetchBlob(...a) }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));
vi.mock('../../../core/store.ts', () => ({
  collection: () => ({ getSnapshot: () => rows, subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)) }),
}));

/** Cache Storage 替身：按 URL 存 Response */
function fakeCaches(): Map<string, Map<string, Response>> {
  const all = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const m = all.get(name) ?? new Map<string, Response>();
    all.set(name, m);
    return {
      match: async (k: string) => m.get(k)?.clone(),
      put: async (k: string, r: Response) => void m.set(k, r),
      delete: async (k: string) => m.delete(k),
      keys: async () => [...m.keys()].map((u) => ({ url: u })),
    };
  };
  vi.stubGlobal('caches', { open });
  return all;
}

const PATH = 'u1/anniv/a1/11111111-2222-4333-8444-555555555555.webp';
const ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  vi.resetModules();
  sign.mockReset().mockResolvedValue([{ ok: true, url: '/files/x', sig: 's' }]);
  fetchBlob.mockReset().mockResolvedValue({ ok: true, blob: new Blob([new Uint8Array(9)], { type: 'image/webp' }) });
  rows = [{ id: 'a1', avatar_id: ID }];
  subs.clear();
});

describe('头像缓存（Cache Storage）', () => {
  it('第一次签名取图并存进缓存；重开（模块重载）后直接读缓存，不再签名', async () => {
    const all = fakeCaches();
    const v1 = await import('../data/avatar-view.ts');
    expect(await v1.loadAvatar(PATH)).toMatch(/^blob:/);
    expect(sign).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect([...(all.get('lemo-anniv-avatar')?.keys() ?? [])].some((k) => k.endsWith(ID))).toBe(true));
    vi.resetModules();
    const v2 = await import('../data/avatar-view.ts');
    expect(await v2.loadAvatar(PATH)).toMatch(/^blob:/);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('本机刚传的那一张也存；这一条换了头像（avatar_id 不在了）缓存里删掉', async () => {
    const all = fakeCaches();
    const v = await import('../data/avatar-view.ts');
    v.seedAvatar(ID, new Blob([new Uint8Array(3)]));
    await vi.waitFor(() => expect(all.get('lemo-anniv-avatar')?.size).toBe(1));
    rows = [{ id: 'a1', avatar_id: 'other' }];
    for (const f of subs) f();
    await vi.waitFor(() => expect(all.get('lemo-anniv-avatar')?.size).toBe(0));
  });

  it('缓存打不开（隐私模式）：照常签名取图', async () => {
    vi.stubGlobal('caches', { open: () => Promise.reject(new Error('SecurityError')) });
    const v = await import('../data/avatar-view.ts');
    expect(await v.loadAvatar(PATH)).toMatch(/^blob:/);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
