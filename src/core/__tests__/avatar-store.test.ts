// 头像仓（core/avatar-store.ts；R-384 整块评审第 1、4、5、10 条）：地址只在仓里生成和撤销；live 里没有的撤掉、删缓存（只删一次）；
// 取不到不记、下次再取；取回来时已经不在 live 里的不留不存；写缓存时顺手删掉 live 里没有的；缓存里有就不加载取图模块
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sign = vi.fn();
const fetchBlob = vi.fn();
vi.mock('../../platform/files.ts', () => ({ SIGN_BATCH_MAX: 100, sign: (...a: unknown[]) => sign(...a), fetchBlob: (...a: unknown[]) => fetchBlob(...a), upload: vi.fn() }));
vi.mock('../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));

/** Cache Storage 替身：按 URL 存 Response，记下删了哪些 */
function fakeCaches(): { all: Map<string, Map<string, Response>>; deleted: string[] } {
  const all = new Map<string, Map<string, Response>>();
  const deleted: string[] = [];
  const open = async (name: string) => {
    const m = all.get(name) ?? new Map<string, Response>();
    all.set(name, m);
    return {
      match: async (k: string) => m.get(k)?.clone(),
      put: async (k: string, r: Response) => void m.set(k, r),
      delete: async (k: string) => (deleted.push(k), m.delete(k)),
      keys: async () => [...m.keys()].map((u) => ({ url: u })),
    };
  };
  vi.stubGlobal('caches', { open });
  return { all, deleted };
}

let live = new Set<string>();
let watchFn: (() => void) | null = null;
const spec = {
  cache: 'c-test',
  keyPrefix: '__t',
  tag: 't',
  path: (id: string) => `u1/t/${id}.webp`,
  live: () => live,
  watch: (fn: () => void) => void (watchFn = fn),
};
const key = (id: string): string => `${location.origin}/__t/${id}`;
const img = (): Blob => new Blob([new Uint8Array(4)], { type: 'image/webp' });

let n = 0;
beforeEach(() => {
  vi.resetModules();
  n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  sign.mockReset().mockResolvedValue([{ ok: true, url: '/files/x', sig: 's' }]);
  fetchBlob.mockReset().mockResolvedValue({ ok: true, blob: img() });
  live = new Set(['a']);
  watchFn = null;
});

const store = async () => (await import('../avatar-store.ts')).createAvatarStore(spec);

describe('头像仓', () => {
  it('网络取到：记下地址、通知订阅者、存进缓存；第二次直接用内存里的', async () => {
    const { all } = fakeCaches();
    const s = await store();
    const seen = vi.fn();
    s.subscribe(seen);
    expect(await s.load(s.path('a'))).toBe('blob:1');
    expect(s.peek('a')).toBe('blob:1');
    expect(seen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(all.get('c-test')?.has(key('a'))).toBe(true));
    expect(await s.load(s.path('a'))).toBe('blob:1');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('缓存里有：不签名取图', async () => {
    const { all } = fakeCaches();
    all.set('c-test', new Map([[key('a'), new Response(img())]]));
    const s = await store();
    expect(await s.load(s.path('a'))).toBe('blob:1');
    expect(sign).not.toHaveBeenCalled();
  });

  it('第 4 条：取不到不记，下一次 load 照样再取', async () => {
    fakeCaches();
    fetchBlob.mockResolvedValueOnce({ ok: false, kind: 'retry', code: 'offline' });
    const s = await store();
    expect(await s.load(s.path('a'))).toBeNull();
    expect(s.peek('a')).toBeNull();
    expect(await s.load(s.path('a'))).toBe('blob:1');
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('第 5 条：取的时候换了头像（id 不在 live 了），取回来的不留、不存', async () => {
    const { all } = fakeCaches();
    let release: (v: unknown) => void = () => undefined;
    fetchBlob.mockReturnValueOnce(new Promise((r) => (release = r)));
    const s = await store();
    const p = s.load(s.path('a'));
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalled());
    live = new Set(['b']);
    release({ ok: true, blob: img() });
    expect(await p).toBeNull();
    expect(s.peek('a')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(all.get('c-test')?.size ?? 0).toBe(0);
  });

  it('第 1 条：seed 的地址就是界面用的那一个；live 变了撤掉、删缓存，只删一次', async () => {
    const { all, deleted } = fakeCaches();
    const s = await store();
    const seen = vi.fn();
    s.subscribe(seen);
    await s.seed('a', img());
    expect(s.peek('a')).toBe('blob:1');
    expect(all.get('c-test')?.has(key('a'))).toBe(true);
    live = new Set(['b']);
    watchFn?.();
    expect(s.peek('a')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    await vi.waitFor(() => expect(all.get('c-test')?.size).toBe(0));
    expect(deleted.filter((k) => k === key('a'))).toHaveLength(1);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('prune：live 变了却没有通知时，当场撤掉不在 live 里的', async () => {
    const { all } = fakeCaches();
    const s = await store();
    await s.seed('x', img());
    s.prune();
    expect(s.peek('x')).toBeNull();
    await vi.waitFor(() => expect(all.get('c-test')?.size ?? 0).toBe(0));
  });

  it('第 10 条：写缓存时顺手删掉 live 里没有的旧头像（这一次打开没见过的也删），这一张本身留着', async () => {
    const { all } = fakeCaches();
    all.set('c-test', new Map([[key('old'), new Response(img())], [key('a'), new Response(img())]]));
    live = new Set(['a']);
    const s = await store();
    await s.seed('new', img());
    expect([...(all.get('c-test')?.keys() ?? [])].sort()).toEqual([key('a'), key('new')].sort());
  });
});
