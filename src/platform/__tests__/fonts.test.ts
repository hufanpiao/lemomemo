// 可选字体的加载（架构 5.9c 第 3 点）：platform/fonts.ts。
// 预取分片逐个下载、核对 sha256、报进度；样式 link 加载好、document.fonts.load 确认后才设 data-font；
// 失败（分片哈希不对、样式加载不了、20 秒超时）回到系统字体、状态 fail、重试能再来；清单里没有的 id 按系统字体；同时只认最后一次
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SHARD = new Uint8Array([1, 2, 3]).buffer;
const hex = async (b: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

let shardSha = '';
let shardOk = true;
const fontsLoad = vi.fn(() => Promise.resolve([]));

function entry(id: string) {
  return {
    id,
    label: { zh: '文楷', ko: '손글씨' },
    css: `/app/fonts/${id}/fonts.abc.css`,
    family: `lemo-${id}-zh`,
    sample: '永和九年',
    prefetch: [{ url: `/app/fonts/${id}/zh-0-0.a.woff2`, sha256: shardSha }, { url: `/app/fonts/${id}/zh-0-1.b.woff2`, sha256: shardSha }],
  };
}

function stubNet(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/app/fonts-index.json') return Promise.resolve(new Response(JSON.stringify({ v: 1, fonts: [entry('kai'), entry('yozai')] })));
      return Promise.resolve(new Response(shardOk ? SHARD : new Uint8Array([9]).buffer));
    }),
  );
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

beforeEach(async () => {
  shardSha = await hex(SHARD);
  shardOk = true;
  document.head.replaceChildren();
  delete html().dataset['font'];
  Object.defineProperty(document, 'fonts', { value: { load: fontsLoad }, configurable: true });
  fontsLoad.mockClear();
  stubNet();
});
afterEach(() => {
  watcher?.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('applyFont', () => {
  it('预取分片下完、哈希对、样式加载好、fonts.load 确认了才设 data-font；进度一路报上来', async () => {
    linkBehaves('load');
    const m = await load();
    const seen: number[] = [];
    m.fontState.subscribe(() => seen.push(m.fontState.get().pct));
    await m.applyFont('kai');
    expect(html().dataset['font']).toBe('kai');
    expect(link()?.getAttribute('href')).toBe('/app/fonts/kai/fonts.abc.css');
    expect(fontsLoad).toHaveBeenCalledWith('400 16px "lemo-kai-zh"', '永和九年');
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'ok', pct: 100 });
    expect(seen).toEqual([0, 50, 99, 100]);
  });

  it('换回系统字体：拿掉 link 和 data-font', async () => {
    linkBehaves('load');
    const m = await load();
    await m.applyFont('kai');
    await m.applyFont('system');
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(m.fontState.get()).toEqual({ id: 'system', status: 'ok', pct: 100 });
  });

  it('分片哈希不对：不设 data-font、不留 link，状态 fail；修好后重试成功', async () => {
    linkBehaves('load');
    shardOk = false;
    const m = await load();
    await m.applyFont('kai');
    expect(html().dataset['font']).toBeUndefined();
    expect(link()).toBeNull();
    expect(m.fontState.get()).toEqual({ id: 'kai', status: 'fail', pct: 0 });
    shardOk = true;
    await m.retryFont();
    expect(html().dataset['font']).toBe('kai');
  });

  it('样式加载不了：fail', async () => {
    linkBehaves('error');
    const m = await load();
    await m.applyFont('kai');
    expect(m.fontState.get().status).toBe('fail');
    expect(html().dataset['font']).toBeUndefined();
  });

  it('20 秒还没好：超时 fail', async () => {
    linkBehaves('never');
    vi.useFakeTimers();
    const m = await load();
    const p = m.applyFont('kai');
    // 等读完清单、进了下载（计时从这里开始）
    for (let i = 0; i < 100 && m.fontState.get().status !== 'loading'; i++) await vi.advanceTimersByTimeAsync(1);
    expect(m.fontState.get().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(m.fontState.get().status).toBe('fail');
    expect(link()).toBeNull();
  });

  it('清单里没有的 id、清单读不到：按系统字体，不报失败', async () => {
    linkBehaves('load');
    const m = await load();
    await m.applyFont('round');
    expect(m.fontState.get()).toEqual({ id: 'system', status: 'ok', pct: 100 });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    const m2 = await load();
    expect(await m2.fontIndex()).toEqual([]);
  });

  it('连着换两次：只认最后一次', async () => {
    linkBehaves('load');
    const m = await load();
    const a = m.applyFont('kai');
    const b = m.applyFont('yozai');
    await Promise.all([a, b]);
    expect(html().dataset['font']).toBe('yozai');
    expect(link()?.getAttribute('href')).toBe('/app/fonts/yozai/fonts.abc.css');
  });
});
