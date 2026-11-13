// 皮肤、深浅色写到 <html> 上（ADR-008；R-06、R-20、R-84、R-93）：platform/look.ts。
// 字体 ui.font（架构 5.9c）：不是系统字体才懒加载 platform/fonts.ts 去套，换回系统字体同样交给它；认不出的 id 按系统字体。
// 本机缓存先套、跟随系统按 prefers-color-scheme 算并跟着系统切换、meta color-scheme 跟着改、settings 集合是空的不覆盖缓存、认不出的值按默认
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MQ = { matches: boolean; media: string; addEventListener(t: string, f: () => void): void; removeEventListener(): void };
let darkMq: MQ;
let onChange: (() => void) | null;

function stubSystem(dark: boolean): void {
  onChange = null;
  darkMq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_t, f) => {
      onChange = f;
    },
    removeEventListener: () => undefined,
  };
  vi.stubGlobal('matchMedia', (q: string) => (q === '(prefers-color-scheme: dark)' ? darkMq : { matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
}

const html = () => document.documentElement;
async function load() {
  vi.resetModules();
  return import('../look.ts');
}
type Row = { id: string; key?: unknown; value?: unknown; deleted_at?: unknown; undone?: unknown };
/** 和 core/store 的集合同样的 getSnapshot / subscribe / upsert（platform 不能引 core） */
function fakeCollection() {
  const byId = new Map<string, Row>();
  const ls = new Set<() => void>();
  let snap: readonly Row[] = [];
  return {
    getSnapshot: () => snap,
    subscribe(l: () => void) {
      ls.add(l);
      return () => void ls.delete(l);
    },
    upsert(rows: Row[]) {
      for (const r of rows) byId.set(r.id, r);
      snap = [...byId.values()];
      for (const l of [...ls]) l();
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  const meta = document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'light';
  document.head.replaceChildren(meta);
  html().dataset['skin'] = 'simple';
  html().dataset['theme'] = 'light';
  delete html().dataset['rt'];
  delete html().dataset['rm'];
  stubSystem(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('一加载就按本机缓存套上', () => {
  it('没有缓存：简洁、跟随系统（系统深色 → data-theme=dark），两个开关关；meta color-scheme 跟着改', async () => {
    stubSystem(true);
    await load();
    expect(html().dataset['skin']).toBe('simple');
    expect(html().dataset['theme']).toBe('dark');
    expect(html().dataset['rt']).toBeUndefined();
    expect(html().dataset['rm']).toBeUndefined();
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark');
  });

  it('缓存里是磨砂玻璃、强制浅色、两个开关开：系统深色也按浅色；写 data-rt、data-rm', async () => {
    stubSystem(true);
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'glass', theme: 'light', rt: true, rm: true }));
    await load();
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['theme']).toBe('light');
    expect(html().dataset['rt']).toBe('1');
    expect(html().dataset['rm']).toBe('1');
  });

  it('缓存坏了、值认不出：按默认', async () => {
    localStorage.setItem('pv-look', '{oops');
    const m = await load();
    expect(m.cachedLook()).toEqual({ skin: 'simple', theme: 'system', rt: false, rm: false, font: 'system' });
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'neon', theme: 'auto', rt: 'yes', rm: 1 }));
    expect(m.cachedLook()).toEqual({ skin: 'simple', theme: 'system', rt: false, rm: false, font: 'system' });
  });
});

describe('跟随系统', () => {
  it('系统切换深浅时 data-theme 跟着改；强制深色后系统再切也不动', async () => {
    const m = await load();
    expect(html().dataset['theme']).toBe('light');
    darkMq.matches = true;
    onChange?.();
    expect(html().dataset['theme']).toBe('dark');
    m.applyLook({ skin: 'simple', theme: 'dark', rt: false, rm: false, font: 'system' });
    darkMq.matches = false;
    onChange?.();
    expect(html().dataset['theme']).toBe('dark');
  });
});

describe('watchLook 盯住 settings', () => {
  it('集合是空的不覆盖缓存；灌进来、改了、删了都重新套，并写进缓存', async () => {
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'glass', theme: 'dark' }));
    const m = await load();
    const c = fakeCollection();
    const stop = m.watchLook(c);
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['theme']).toBe('dark');

    c.upsert([{ id: '1', key: 'notes.view@mobile', value: 'list' }]);
    // 有设置行、但没有皮肤的键：按默认（这个账号没选过）
    expect(html().dataset['skin']).toBe('simple');
    expect(html().dataset['theme']).toBe('light');

    c.upsert([{ id: '2', key: 'ui.skin', value: 'glass' }, { id: '3', key: 'ui.theme', value: 'dark' }, { id: '4', key: 'ui.reduce_motion', value: true }]);
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['theme']).toBe('dark');
    expect(html().dataset['rm']).toBe('1');
    expect(JSON.parse(localStorage.getItem('pv-look') ?? '{}')).toEqual({ skin: 'glass', theme: 'dark', rt: false, rm: true, font: 'system' });

    // 删了、撤销了的行不算
    c.upsert([{ id: '2', key: 'ui.skin', value: 'glass', deleted_at: 1 }, { id: '4', key: 'ui.reduce_motion', value: true, undone: true }]);
    expect(html().dataset['skin']).toBe('simple');
    expect(html().dataset['rm']).toBeUndefined();
    stop();
    c.upsert([{ id: '5', key: 'ui.skin', value: 'glass' }]);
    expect(html().dataset['skin']).toBe('simple');
  });
});

describe('字体 ui.font', () => {
  it('值是 {v: 1, id}（设置）或 id（缓存）；认不出的按系统字体', async () => {
    const m = await load();
    expect(m.lookOf((k) => (k === 'font' ? { v: 1, id: 'kai' } : undefined)).font).toBe('kai');
    expect(m.lookOf((k) => (k === 'font' ? 'yozai' : undefined)).font).toBe('yozai');
    for (const bad of [{ v: 1, id: 'Kai!' }, { v: 1 }, 7, null, '']) expect(m.lookOf((k) => (k === 'font' ? bad : undefined)).font).toBe('system');
  });

  it('系统字体不加载 fonts.ts；选了别的才交给它，换回系统字体再交给它拿掉', async () => {
    const applyFont = vi.fn(() => Promise.resolve());
    vi.doMock('../fonts.ts', () => ({ applyFont }));
    const m = await load();
    const c = fakeCollection();
    m.watchLook(c);
    c.upsert([{ id: '1', key: 'ui.skin', value: 'glass' }]);
    await vi.dynamicImportSettled();
    expect(applyFont).not.toHaveBeenCalled();
    c.upsert([{ id: '2', key: 'ui.font', value: { v: 1, id: 'kai' } }]);
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenLastCalledWith('kai');
    expect(JSON.parse(localStorage.getItem('pv-look') ?? '{}')).toMatchObject({ font: 'kai' });
    c.upsert([{ id: '2', key: 'ui.font', value: { v: 1, id: 'kai' }, deleted_at: 1 }]);
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenLastCalledWith('system');
    expect(applyFont).toHaveBeenCalledTimes(2);
    vi.doUnmock('../fonts.ts');
  });

  it('冷启动缓存里是文楷：一加载就交给 fonts.ts', async () => {
    const applyFont = vi.fn(() => Promise.resolve());
    vi.doMock('../fonts.ts', () => ({ applyFont }));
    localStorage.setItem('pv-look', JSON.stringify({ font: 'kai' }));
    await load();
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenCalledWith('kai');
    vi.doUnmock('../fonts.ts');
  });
});
