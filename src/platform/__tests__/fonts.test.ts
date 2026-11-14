// 可选字体的加载（架构 5.9c 第 3 点；皮肤字体整块评审 11-14 第 3、4、5、9 条）：platform/fonts.ts。
// 预取分片逐个下载、核对 sha256、报进度；样式 link 加载好、document.fonts.load 用中文和韩文样例各确认一次（返回空算失败）后才设 data-font；
// 失败（分片哈希不对、样式加载不了、20 秒超时、确认不到）回到系统字体、状态 fail、重试能再来；哈希不对的分片从缓存删掉；
// 清单里没有的 id 按系统字体；同时只认最后一次、被顶掉的下载中止；冷启动上次确认过的直接套上、后台静默核对；
// 换字体一天后清掉缓存里不属于当前字体的文件；运行日志 font_load 开始、完成、失败各一行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SHARD = new Uint8Array([1, 2, 3]).buffer;
const hex = async (b: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

let shardSha = '';
let shardOk = true;
/** 每种字体样式加载以后 document.fonts.load 返回的 face 数（0 = 确认不到） */
let faces = 1;
const fontsLoad = vi.fn(() => Promise.resolve(Array.from({ length: faces }, () => ({}) as FontFace)));
const signals: AbortSignal[] = [];

function entry(id: string) {
  const shards = [`/app/fonts/${id}/zh-0-0.a.woff2`, `/app/fonts/${id}/zh-0-1.b.woff2`];
  return {
    id,
    label: { zh: '文楷', ko: '손글씨' },
    css: `/app/fonts/${id}/fonts.abc.css`,
    family: `lemo-${id}-zh`,
    sample: '永和九年',
    familyKo: `lemo-${id}-ko`,
    sampleKo: '가나다라',
    prefetch: shards.map((url) => ({ url, sha256: shardSha })),
    files: [`/app/fonts/${id}/fonts.abc.css`, ...shards, `/app/fonts/${id}/zh-9.c.woff2`],
  };
}

function stubNet(): void {
  signals.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/app/fonts-index.json') return Promise.resolve(new Response(JSON.stringify({ v: 1, fonts: [entry('kai'), entry('yozai')] })));
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(new Response(shardOk ? SHARD : new Uint8Array([9]).buffer));
    }),
  );
}

/** 假的 Cache Storage：只有 lemo-fonts 一个缓存，记下删了哪些 */
const cached = new Set<string>();
const deleted: string[] = [];
function stubCaches(): void {
  cached.clear();
  deleted.length = 0;
  const cache = {
    keys: () => Promise.resolve([...cached].map((p) => ({ url: `http://localhost${p}` }) as Request)),
    delete: (r: string | Request) => {
      const p = typeof r === 'string' ? r : new URL(r.url).pathname;
      deleted.push(p);
      return Promise.resolve(cached.delete(p));
    },
  };
  vi.stubGlobal('caches', { open: vi.fn(() => Promise.resolve(cache)) });
}

/** jsdom 不真加载样式：link 一挂上就按 how 回 load / error（never = 一直不回） */
let watcher: MutationObserver | null = null;
function linkBehaves(how: 'load' | 'error' | 'never'): void {
  watcher = new MutationObserver((ms) => {
    for (const m of ms)
      for (const n of m.addedNodes)
        if (n instanceof HTMLLinkElement && how !== 'never') queueMicrotask(() => n.dispatchEvent(new Event(how)));
  });
  watcher.observe(document.head, { childList: true });
}

async function load() {
  vi.resetModules();
  return import('../fonts.ts');
}
const html = () => document.documentElement;
const link = () => document.getElementById('lemo-font');
const codes = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((c) => (c[1] as { code: string }).code.replace(/ms=\d+/, 'ms=*'));

beforeEach(async () => {
  shardSha = await hex(SHARD);
  shardOk = true;
  faces = 1;
  localStorage.clear();
  document.head.replaceChildren();
  delete html().dataset['font'];
  Object.defineProperty(document, 'fonts', { value: { load: fontsLoad }, configurable: true });
  fontsLoad.mockClear();
  stubNet();
  stubCaches();
});
afterEach(() => {
  watcher?.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('applyFont', () => {
  it('预取分片下完、哈希对、样式加载好、中文和韩文样例都确认了才设 data-font；进度一路报上来；记开始和完成', async () => {
    linkBehaves('load');
    const m = await load();
    const seen: number[] = [];
    const log = vi.fn();
    m.fontState.subscribe(() => seen.push(m.fontState.get().pct));
    await m.applyFont('kai', log);
    expect(html().dataset['font']).toBe('kai');
    expect(link()?.getAttribute('href')).toBe('/app/fonts/kai/fonts.abc.css');
    expect(fontsLoad).toHaveBeenCalledWith('400 16px "lemo-kai-zh"', '永和九年');
    expect(fontsLoad).toHaveBeenCalledWith('400 16px "lemo-kai-ko"', '가나다라');
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'ok', pct: 100 });
    expect(seen).toEqual([0, 50, 99, 100]);
    expect(codes(log)).toEqual(['start download', 'ok ms=* pct=100']);
    expect(log.mock.calls.every((c) => c[0] === 'font_load' && (c[1] as { itemId: string }).itemId === 'kai')).toBe(true);
    expect(JSON.parse(localStorage.getItem('pv-font-ok') ?? 'null')).toEqual({ id: 'kai', css: '/app/fonts/kai/fonts.abc.css' });
  });

  it('换回系统字体：拿掉 link 和 data-font，忘掉上次确认的字体', async () => {
    linkBehaves('load');
    const m = await load();
    await m.applyFont('kai');
    await m.applyFont('system');
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(m.fontState.get()).toEqual({ id: 'system', status: 'ok', pct: 100 });
    expect(localStorage.getItem('pv-font-ok')).toBeNull();
  });

  it('分片哈希不对：先从缓存删掉那个分片，不设 data-font、不留 link，状态 fail、记 font_shard_hash；修好后重试成功', async () => {
    linkBehaves('load');
    shardOk = false;
    cached.add('/app/fonts/kai/zh-0-0.a.woff2');
    const m = await load();
    const log = vi.fn();
    await m.applyFont('kai', log);
    expect(deleted).toContain('/app/fonts/kai/zh-0-0.a.woff2');
    expect(cached.has('/app/fonts/kai/zh-0-0.a.woff2')).toBe(false);
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'fail', pct: 0 });
    expect(codes(log)).toEqual(['start download', 'fail font_shard_hash ms=* pct=0']);
    shardOk = true;
    await m.retryFont();
    expect(html().dataset['font']).toBe('kai');
  });

  it('样式加载不了：fail，记 font_css', async () => {
    linkBehaves('error');
    const m = await load();
    const log = vi.fn();
    await m.applyFont('kai', log);
    expect(m.fontState.get().status).toBe('fail');
    expect(html().dataset['font']).toBeUndefined();
    expect(codes(log).at(-1)).toBe('fail font_css ms=* pct=99');
  });

  it('document.fonts.load 返回空数组（样式到了但字体确认不到）：fail，记 font_face_none', async () => {
    linkBehaves('load');
    faces = 0;
    const m = await load();
    const log = vi.fn();
    await m.applyFont('kai', log);
    expect(m.fontState.get().status).toBe('fail');
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(codes(log).at(-1)).toBe('fail font_face_none ms=* pct=99');
  });

  it('20 秒还没好：中止下载，超时 fail，记 font_timeout', async () => {
    linkBehaves('never');
    vi.useFakeTimers();
    const m = await load();
    const log = vi.fn();
    const p = m.applyFont('kai', log);
    // 等读完清单、进了下载（计时从这里开始）
    for (let i = 0; i < 100 && m.fontState.get().status !== 'loading'; i++) await vi.advanceTimersByTimeAsync(1);
    expect(m.fontState.get().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(m.fontState.get().status).toBe('fail');
    // 超时以后还在跑的那段不能把状态改回 loading
    await vi.advanceTimersByTimeAsync(100);
    expect(m.fontState.get().status).toBe('fail');
    expect(link()).toBeNull();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(codes(log).at(-1)).toMatch(/^fail font_timeout ms=\* pct=\d+$/);
  });

  it('网速慢但一直在下（每个分片 15 秒、合计超过 20 秒）：不算超时，下完照常成功（11-14 真机日志 font_timeout pct=57）', async () => {
    linkBehaves('load');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = vi.fn((url: string) => {
      if (url === '/app/fonts-index.json') return Promise.resolve(new Response(JSON.stringify({ v: 1, fonts: [entry('kai')] })));
      return new Promise<Response>((ok) => setTimeout(() => ok(new Response(SHARD)), 15_000));
    });
    vi.stubGlobal('fetch', net);
    const m = await load();
    const log = vi.fn();
    const p = m.applyFont('kai', log);
    // 两个分片各 15 秒（合计 30 秒，旧的 20 秒总时限会在第二片中途掐断）。哈希校验（crypto.subtle）走真实异步，
    // 不赌事件循环跑几轮：每片先等它真的发出请求，推进 15 秒，再等进度真的往前走了才推下一片（11-14 全套检查满负载时偶发红）
    for (const [i, want] of [50, 99].entries()) {
      await vi.waitFor(() => expect(net).toHaveBeenCalledTimes(i + 2));
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(m.fontState.get().pct).toBeGreaterThanOrEqual(want));
    }
    await p;
    expect(codes(log)).toEqual(['start download', 'ok ms=* pct=100']);
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'ok', pct: 100 });
  });

  it('清单里没有的 id、清单读不到：按系统字体，不报失败；读不到清单记 index_<状态码>', async () => {
    linkBehaves('load');
    const m = await load();
    await m.applyFont('round');
    expect(m.fontState.get()).toEqual({ id: 'system', status: 'ok', pct: 100 });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    const m2 = await load();
    const log = vi.fn();
    await m2.applyFont('kai', log);
    expect(m2.fontState.get()).toEqual({ id: 'system', status: 'ok', pct: 100 });
    expect(codes(log)).toEqual(['start download', 'index index_404']);
    expect(await m2.fontIndex()).toEqual([]);
  });

  it('连着换两次：只认最后一次，前一次的下载中止', async () => {
    linkBehaves('load');
    const m = await load();
    const a = m.applyFont('kai');
    const b = m.applyFont('yozai');
    await Promise.all([a, b]);
    expect(html().dataset['font']).toBe('yozai');
    expect(link()?.getAttribute('href')).toBe('/app/fonts/yozai/fonts.abc.css');
    expect(m.fontState.get()).toEqual({ id: 'yozai', status: 'ok', pct: 100 });
  });

  it('被下一次顶掉的那次：signal 已中止（换了不再接着下）', async () => {
    linkBehaves('load');
    const m = await load();
    const a = m.applyFont('kai');
    // 等第一次进到下载
    for (let i = 0; i < 50 && signals.length === 0; i++) await Promise.resolve();
    const first = signals[0];
    await m.applyFont('system');
    await a;
    expect(first?.aborted).toBe(true);
    expect(html().dataset['font']).toBeUndefined();
  });
});

describe('冷启动快路（第 5 条）', () => {
  it('上次确认过同一种字体：一调用就设 data-font、状态 ok，不报“下载中”；后台核对通过照样 ok', async () => {
    linkBehaves('load');
    localStorage.setItem('pv-font-ok', JSON.stringify({ id: 'kai', css: '/app/fonts/kai/fonts.abc.css' }));
    const m = await load();
    const seen: string[] = [];
    m.fontState.subscribe(() => seen.push(m.fontState.get().status));
    const log = vi.fn();
    const p = m.applyFont('kai', log);
    expect(html().dataset['font']).toBe('kai');
    expect(link()?.getAttribute('href')).toBe('/app/fonts/kai/fonts.abc.css');
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'ok', pct: 100 });
    await p;
    expect(seen).not.toContain('loading');
    expect(html().dataset['font']).toBe('kai');
    expect(codes(log)).toEqual(['start cached', 'ok ms=* pct=100']);
  });

  it('后台核对不过（哈希不对）：回到系统字体、状态 fail，忘掉确认记录', async () => {
    linkBehaves('load');
    shardOk = false;
    localStorage.setItem('pv-font-ok', JSON.stringify({ id: 'kai', css: '/app/fonts/kai/fonts.abc.css' }));
    const m = await load();
    await m.applyFont('kai');
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(m.fontState.get().status).toBe('fail');
    expect(localStorage.getItem('pv-font-ok')).toBeNull();
  });

  it('确认过的是另一种字体：照常下载（报进度）', async () => {
    linkBehaves('load');
    localStorage.setItem('pv-font-ok', JSON.stringify({ id: 'yozai', css: '/app/fonts/yozai/fonts.abc.css' }));
    const m = await load();
    const seen: string[] = [];
    m.fontState.subscribe(() => seen.push(m.fontState.get().status));
    await m.applyFont('kai');
    expect(seen[0]).toBe('loading');
    expect(html().dataset['font']).toBe('kai');
  });
});

describe('缓存清理（5.9c，第 4 条）', () => {
  it('换字体先记时刻、不删；过了一天再套时删掉不属于当前字体的文件，删完不再删', async () => {
    linkBehaves('load');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    for (const p of ['/app/fonts/kai/zh-0-0.a.woff2', '/app/fonts/kai/zh-9.c.woff2', '/app/fonts/yozai/zh-0-0.a.woff2', '/app/fonts/old/x.woff2']) cached.add(p);
    const m = await load();
    await m.applyFont('kai');
    expect(deleted).toEqual([]);
    expect(JSON.parse(localStorage.getItem('pv-font-gc') ?? 'null')).toEqual({ id: 'kai', at: Date.now() });
    vi.setSystemTime(new Date('2026-11-14T23:00:00Z'));
    await m.applyFont('kai');
    expect(deleted).toEqual([]);
    vi.setSystemTime(new Date('2026-11-15T00:00:01Z'));
    await m.applyFont('kai');
    expect([...cached].sort()).toEqual(['/app/fonts/kai/zh-0-0.a.woff2', '/app/fonts/kai/zh-9.c.woff2']);
    expect(JSON.parse(localStorage.getItem('pv-font-gc') ?? 'null')).toEqual({ id: 'kai', at: 0 });
    deleted.length = 0;
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    await m.applyFont('kai');
    expect(deleted).toEqual([]);
  });

  it('换回系统字体一天后：字体缓存全部删掉', async () => {
    linkBehaves('load');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    cached.add('/app/fonts/kai/zh-0-0.a.woff2');
    const m = await load();
    await m.applyFont('system');
    expect(cached.size).toBe(1);
    vi.setSystemTime(new Date('2026-11-15T01:00:00Z'));
    await m.applyFont('system');
    expect(cached.size).toBe(0);
  });
});
