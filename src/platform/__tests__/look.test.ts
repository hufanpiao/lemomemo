// 皮肤、深浅色写到 <html> 上（ADR-008；R-06、R-20、R-84、R-93）：platform/look.ts。
// 字体 ui.font（架构 5.9c）：不是系统字体才懒加载 platform/fonts.ts 去套，换回系统字体同样交给它；认不出的 id 按系统字体。
// 本机缓存先套、跟随系统按 prefers-color-scheme 算并跟着系统切换、settings 集合是空的不覆盖缓存、认不出的值按默认。
// 减少透明 / 减少动态（皮肤整块评审 11-14 第 1、6 条）：只看系统设置（设置里的两个开关 11-14 负责人要求去掉），系统变了跟着改；
// 旧账号存过的 ui.reduce_transparency、ui.reduce_motion、旧缓存里的 rt、rm 一律不再生效。
// 运行日志：皮肤、深浅色、两个减少效果变了记 look_apply；字体分包加载不了记 font_load fail font_chunk（第 3、8 条）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MQ = { matches: boolean; media: string; addEventListener(t: string, f: () => void): void; removeEventListener(): void; fire(): void };
const Q = { dark: '(prefers-color-scheme: dark)', rt: '(prefers-reduced-transparency: reduce)', rm: '(prefers-reduced-motion: reduce)' } as const;
let mqs: Record<keyof typeof Q, MQ>;
let darkMq: MQ;
let onChange: (() => void) | null;

function stubSystem(dark: boolean, rt = false, rm = false): void {
  const mk = (media: string, matches: boolean): MQ => {
    const ls = new Set<() => void>();
    return {
      matches,
      media,
      addEventListener: (_t: string, f: () => void) => void ls.add(f),
      removeEventListener: () => undefined,
      fire: () => {
        for (const l of ls) l();
      },
    };
  };
  mqs = { dark: mk(Q.dark, dark), rt: mk(Q.rt, rt), rm: mk(Q.rm, rm) };
  darkMq = mqs.dark;
  onChange = () => mqs.dark.fire();
  vi.stubGlobal('matchMedia', (q: string) => Object.values(mqs).find((m) => m.media === q) ?? { matches: false, media: q, addEventListener() {}, removeEventListener() {} });
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
  it('没有缓存：简洁、跟随系统（系统深色 → data-theme=dark），两个开关关；meta color-scheme 不动（只留 base.css 一套，第 7 条）', async () => {
    stubSystem(true);
    await load();
    expect(html().dataset['skin']).toBe('simple');
    expect(html().dataset['theme']).toBe('dark');
    expect(html().dataset['rt']).toBeUndefined();
    expect(html().dataset['rm']).toBeUndefined();
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('light');
  });

  it('缓存里是磨砂玻璃、强制浅色：系统深色也按浅色；旧缓存里的两个开关（rt、rm）不再生效', async () => {
    stubSystem(true);
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'glass', theme: 'light', rt: true, rm: true }));
    await load();
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['theme']).toBe('light');
    expect(html().dataset['rt']).toBeUndefined();
    expect(html().dataset['rm']).toBeUndefined();
  });

  it('缓存坏了、值认不出：按默认', async () => {
    localStorage.setItem('pv-look', '{oops');
    const m = await load();
    expect(m.cachedLook()).toEqual({ skin: 'simple', theme: 'system', font: 'system' });
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'neon', theme: 'auto', rt: 'yes', rm: 1 }));
    expect(m.cachedLook()).toEqual({ skin: 'simple', theme: 'system', font: 'system' });
  });
});

describe('跟随系统', () => {
  it('系统切换深浅时 data-theme 跟着改；强制深色后系统再切也不动', async () => {
    const m = await load();
    expect(html().dataset['theme']).toBe('light');
    darkMq.matches = true;
    onChange?.();
    expect(html().dataset['theme']).toBe('dark');
    m.applyLook({ skin: 'simple', theme: 'dark', font: 'system' });
    darkMq.matches = false;
    onChange?.();
    expect(html().dataset['theme']).toBe('dark');
  });
});

describe('减少透明、减少动态：只看系统设置（只有这一处判断）', () => {
  it('系统设置了 reduce：写 data-rt、data-rm；系统改回来就拿掉', async () => {
    stubSystem(false, true, true);
    await load();
    expect(html().dataset['rt']).toBe('1');
    expect(html().dataset['rm']).toBe('1');
    mqs.rt.matches = false;
    mqs.rt.fire();
    expect(html().dataset['rt']).toBeUndefined();
    expect(html().dataset['rm']).toBe('1');
    mqs.rm.matches = false;
    mqs.rm.fire();
    expect(html().dataset['rm']).toBeUndefined();
  });

  it('旧账号存过 ui.reduce_transparency / ui.reduce_motion = true：不再生效，系统没设置就不写', async () => {
    const m = await load();
    const c = fakeCollection();
    m.watchLook(c);
    c.upsert([{ id: '1', key: 'ui.reduce_transparency', value: true }, { id: '2', key: 'ui.reduce_motion', value: true }, { id: '3', key: 'ui.skin', value: 'glass' }]);
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['rt']).toBeUndefined();
    expect(html().dataset['rm']).toBeUndefined();
  });
});

describe('运行日志 look_apply', () => {
  it('watchLook 注入日志时补记缓存那一份；之后变了才记，一样的不重复记；系统设置变了也记（rt=sys）', async () => {
    localStorage.setItem('pv-look', JSON.stringify({ skin: 'glass', theme: 'system' }));
    const m = await load();
    const log = vi.fn();
    const c = fakeCollection();
    m.watchLook(c, log);
    expect(log).toHaveBeenLastCalledWith('look_apply', { code: 'cache skin=glass theme=system>light rt=off rm=off' });
    c.upsert([{ id: '1', key: 'ui.skin', value: 'glass' }, { id: '2', key: 'ui.theme', value: 'dark' }]);
    expect(log).toHaveBeenLastCalledWith('look_apply', { code: 'skin=glass theme=dark>dark rt=off rm=off' });
    const n = log.mock.calls.length;
    c.upsert([{ id: '3', key: 'notes.view@mobile', value: 'list' }]);
    expect(log).toHaveBeenCalledTimes(n);
    mqs.rt.matches = true;
    mqs.rt.fire();
    expect(log).toHaveBeenLastCalledWith('look_apply', { code: 'skin=glass theme=dark>dark rt=sys rm=off' });
    // 日志里只有键名和枚举值，没有用户输入的文字
    for (const [, f] of log.mock.calls) expect(Object.keys(f as object)).toEqual(['code']);
  });
});

describe('lookValue：写进 settings 的值', () => {
  it('ui.font 存 {v: 1, id}，其余原样；和 lookOf 来回一致', async () => {
    const m = await load();
    expect(m.lookValue('font', 'kai')).toEqual({ v: 1, id: 'kai' });
    expect(m.lookValue('skin', 'glass')).toBe('glass');
    expect(m.lookValue('theme', 'dark')).toBe('dark');
    const look = { skin: 'glass', theme: 'dark', font: 'kai' } as const;
    expect(m.lookOf((k) => m.lookValue(k, look[k]))).toEqual(look);
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

    c.upsert([{ id: '2', key: 'ui.skin', value: 'glass' }, { id: '3', key: 'ui.theme', value: 'dark' }]);
    expect(html().dataset['skin']).toBe('glass');
    expect(html().dataset['theme']).toBe('dark');
    expect(JSON.parse(localStorage.getItem('pv-look') ?? '{}')).toEqual({ skin: 'glass', theme: 'dark', font: 'system' });

    // 删了、撤销了的行不算
    c.upsert([{ id: '2', key: 'ui.skin', value: 'glass', deleted_at: 1 }, { id: '3', key: 'ui.theme', value: 'dark', undone: true }]);
    expect(html().dataset['skin']).toBe('simple');
    expect(html().dataset['theme']).toBe('light');
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
    expect(applyFont).toHaveBeenLastCalledWith('kai', expect.any(Function));
    expect(JSON.parse(localStorage.getItem('pv-look') ?? '{}')).toMatchObject({ font: 'kai' });
    c.upsert([{ id: '2', key: 'ui.font', value: { v: 1, id: 'kai' }, deleted_at: 1 }]);
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenLastCalledWith('system', expect.any(Function));
    expect(applyFont).toHaveBeenCalledTimes(2);
    vi.doUnmock('../fonts.ts');
  });

  it('冷启动缓存里是文楷：一加载就交给 fonts.ts', async () => {
    const applyFont = vi.fn(() => Promise.resolve());
    vi.doMock('../fonts.ts', () => ({ applyFont }));
    localStorage.setItem('pv-look', JSON.stringify({ font: 'kai' }));
    await load();
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenCalledWith('kai', expect.any(Function));
    vi.doUnmock('../fonts.ts');
  });

  it('fonts.ts 分包加载不了：记 font_load fail font_chunk，退回原值；下次再套时重试', async () => {
    let tries = 0;
    const applyFont = vi.fn(() => Promise.resolve());
    vi.doMock('../fonts.ts', () => {
      tries += 1;
      if (tries === 1) throw new Error('chunk');
      return { applyFont };
    });
    const m = await load();
    const log = vi.fn();
    const c = fakeCollection();
    m.watchLook(c, log);
    c.upsert([{ id: '1', key: 'ui.font', value: { v: 1, id: 'kai' } }]);
    await vi.dynamicImportSettled();
    expect(log).toHaveBeenCalledWith('font_load', { itemId: 'kai', code: 'fail font_chunk' });
    expect(applyFont).not.toHaveBeenCalled();
    // 下一次套（这里是换了皮肤）：字体还是 kai，但上次没套成，再交给 fonts.ts
    c.upsert([{ id: '2', key: 'ui.skin', value: 'glass' }]);
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenCalledWith('kai', expect.any(Function));
    vi.doUnmock('../fonts.ts');
  });

  it('换回系统字体后还有没清的字体缓存（pv-font-gc 记着时刻）：一加载就交给 fonts.ts 到点清', async () => {
    const applyFont = vi.fn(() => Promise.resolve());
    vi.doMock('../fonts.ts', () => ({ applyFont }));
    localStorage.setItem('pv-font-gc', JSON.stringify({ id: 'system', at: 123 }));
    await load();
    await vi.dynamicImportSettled();
    expect(applyFont).toHaveBeenCalledWith('system');
    applyFont.mockClear();
    localStorage.setItem('pv-font-gc', JSON.stringify({ id: 'system', at: 0 }));
    await load();
    await vi.dynamicImportSettled();
    expect(applyFont).not.toHaveBeenCalled();
    vi.doUnmock('../fonts.ts');
  });
});
