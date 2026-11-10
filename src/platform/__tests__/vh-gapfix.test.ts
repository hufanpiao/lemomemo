// 底栏偏高修复候选 Gap fix（platform/vh-gapfix.ts，R-371 11-10）：开关存本机；只在“主屏幕版、竖屏、少的正好是顶部安全区”时放垫块让文档比视口高，
// innerHeight 变了或到点就撤；600ms 没变补一次滚 1px 再滚回；正常启动、网页版、横屏一律不动；每一步记日志
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIVE_UP_MS, gapFixOn, ON_KEY, OUT_KEY, PAD_ID, readGapFixLog, SCROLL_AT_MS, setGapFixOn, skipReason, startGapFix, TOL_PX, TOP_RETRY_FRAMES, TOP_RETRY_MS, WAIT_BAR_MS } from '../vh-gapfix.ts';

/** 手动推进的“帧” */
function frames() {
  const q: Array<() => void> = [];
  return {
    frame: (cb: () => void) => q.push(cb),
    flush(n = 1) {
      for (let k = 0; k < n; k++) q.shift()?.();
    },
    get size() {
      return q.length;
    },
  };
}

let inner = 895;
let clock = 0;
/** 页面滚动位置（scrollBy / scrollTo 的替身改它） */
let sy = 0;
const mockScroll = () => ({
  by: vi.spyOn(window, 'scrollBy').mockImplementation(((_x: number, y: number) => {
    sy += y;
  }) as typeof window.scrollBy),
  to: vi.spyOn(window, 'scrollTo').mockImplementation(((_x: number, y: number) => {
    sy = y;
  }) as typeof window.scrollTo),
});
const setInner = (h: number) => {
  inner = h;
};
const mountBar = (): HTMLElement => {
  const el = document.createElement('nav');
  el.dataset['testid'] = 'tabbar';
  document.body.append(el);
  return el;
};
const pad = () => document.getElementById(PAD_ID);
const deps = (over: { standalone?: boolean; top?: number | (() => number) } = {}) => ({ now: () => clock, standalone: true, top: 61, ...over });

beforeEach(() => {
  localStorage.clear();
  inner = 895;
  clock = 0;
  sy = 0;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => sy);
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(440);
  vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
  vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('开关', () => {
  it('开、关存在本机；本机存储抛错时当没开、不抛', () => {
    expect(gapFixOn()).toBe(false);
    setGapFixOn(true);
    expect(localStorage.getItem(ON_KEY)).toBe('1');
    expect(gapFixOn()).toBe(true);
    setGapFixOn(false);
    expect(localStorage.getItem(ON_KEY)).toBeNull();
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
      removeItem: () => {
        throw new Error('x');
      },
    } as unknown as Storage;
    expect(gapFixOn(bad)).toBe(false);
    expect(() => setGapFixOn(true, bad)).not.toThrow();
    expect(readGapFixLog(bad)).toBe('');
  });

  it('main.tsx 读的键名就是 ON_KEY，并且和时间线一起只在非正式版里读', () => {
    const main = readFileSync(resolve(__dirname, '../../app/main.tsx'), 'utf8');
    expect(main).toContain(`localStorage.getItem('${ON_KEY}')`);
    const block = main.slice(main.indexOf("import.meta.env.MODE !== 'production'"));
    expect(block.indexOf(`localStorage.getItem('${ON_KEY}')`)).toBeGreaterThan(0);
    expect(block.indexOf(`localStorage.getItem('${ON_KEY}')`)).toBeLessThan(block.indexOf('} catch'));
  });
});

describe('skipReason：只在“主屏幕版、竖屏、少的正好是顶部安全区”时做', () => {
  const base = { standalone: true, inner: 895, width: 440, screenH: 956, top: 61 };
  it('负责人那次（895 / 956，顶部 61）要做', () => expect(skipReason(base)).toBeNull());
  it(`差值和顶部安全区差 ${TOL_PX} 以内也做，多 1 就不做`, () => {
    expect(skipReason({ ...base, top: 61 - TOL_PX })).toBeNull();
    expect(skipReason({ ...base, top: 61 + TOL_PX + 1 })).toMatch(/^gap-not-top/);
  });
  it('正常启动（inner = 屏幕高）、网页版、横屏、iPad 窗口化（差值不是顶部安全区）都不做', () => {
    expect(skipReason({ ...base, inner: 956 })).toBe('no-gap(0)');
    expect(skipReason({ ...base, standalone: false })).toBe('not-standalone');
    expect(skipReason({ ...base, width: 956, inner: 440, screenH: 440 })).toBe('landscape');
    expect(skipReason({ ...base, inner: 700, top: 24 })).toMatch(/^gap-not-top/);
  });
});

describe('startGapFix', () => {
  it('底栏挂上以前不判断；挂上后放垫块（绝对定位、看不见、不接点按，高一屏 + 差值 + 1px），innerHeight 一变就撤掉、记 by-pad', () => {
    const f = frames();
    startGapFix(f.frame, deps());
    f.flush(3);
    expect(pad()).toBeNull();
    mountBar();
    f.flush();
    const p = pad();
    expect(p).not.toBeNull();
    expect(p?.getAttribute('aria-hidden')).toBe('true');
    expect(p?.style.position).toBe('absolute');
    expect(p?.style.visibility).toBe('hidden');
    expect(p?.style.pointerEvents).toBe('none');
    expect(p?.style.height).toBe('calc(100dvh + 62px)');
    clock = 50;
    f.flush();
    expect(pad()).not.toBeNull();
    setInner(956);
    clock = 80;
    f.flush();
    expect(pad()).toBeNull();
    const log = localStorage.getItem(OUT_KEY) ?? '';
    expect(log).toMatch(/pad gap=61 top=61/);
    expect(log).toMatch(/changed 895->956 by-pad pad-removed inner=956/);
  });

  it(`${SCROLL_AT_MS}ms 还没变：滚 1px、下一帧滚回；到 ${GIVE_UP_MS}ms 撤掉垫块、记 no-change`, () => {
    const { by, to } = mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    clock = SCROLL_AT_MS;
    f.flush();
    expect(by).toHaveBeenCalledWith(0, 1);
    f.flush();
    expect(to).toHaveBeenCalledWith(0, 0);
    expect(to).toHaveBeenCalledTimes(1);
    clock = GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    // 代码审 M1：撤垫块时已经滚回过，不再多滚一次
    expect(to).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(OUT_KEY)).toMatch(/scrollBy1[\s\S]*no-change pad-removed/);
    expect(f.size).toBe(0);
  });

  it('代码审 M1：滚 1px 以后用户自己在滚（切到日历往下翻），滚回和撤垫块都不把页面拉回去', () => {
    const { to } = mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    clock = SCROLL_AT_MS;
    f.flush();
    expect(sy).toBe(1);
    sy = 300;
    f.flush();
    clock = GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(to).not.toHaveBeenCalled();
    expect(sy).toBe(300);
  });

  it('代码审 M1：滚 1px 后还没到滚回那一帧就撤垫块（innerHeight 变了），还停在那 1px 上才滚回一次', () => {
    const { to } = mockScroll();
    mountBar();
    const f = frames();
    const stop = startGapFix(f.frame, deps());
    clock = SCROLL_AT_MS;
    f.flush();
    stop();
    expect(to).toHaveBeenCalledTimes(1);
    expect(sy).toBe(0);
    f.flush(3);
    expect(to).toHaveBeenCalledTimes(1);
  });

  it(`计时从放垫块算起：底栏 ${WAIT_BAR_MS - 1000}ms 才挂上，放了垫块不会马上撤`, () => {
    mockScroll();
    const f = frames();
    startGapFix(f.frame, deps());
    clock = WAIT_BAR_MS - 1000;
    mountBar();
    f.flush();
    expect(pad()).not.toBeNull();
    clock += 50;
    f.flush();
    expect(pad()).not.toBeNull();
    clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
  });

  it(`建议 1：顶部安全区先读到 0（先 0 后 61）：每 ${TOP_RETRY_FRAMES} 帧重读，读到 61 照做，日志记重读结果`, () => {
    mockScroll();
    mountBar();
    const reads = [0, 0, 61];
    const f = frames();
    startGapFix(f.frame, deps({ top: () => reads.shift() ?? 61 }));
    expect(pad()).toBeNull();
    clock = 30;
    f.flush(TOP_RETRY_FRAMES - 1);
    expect(pad()).toBeNull();
    f.flush(1);
    expect(pad()).toBeNull();
    clock = 60;
    f.flush(TOP_RETRY_FRAMES);
    expect(pad()).not.toBeNull();
    const log = readGapFixLog();
    expect(log).toMatch(/top=0 reread every 4 frames/);
    expect(log).toMatch(/top-reread tries=2 after=60ms top=61/);
    expect(log).toMatch(/pad gap=61 top=61/);
  });

  it(`建议 1：顶部安全区一直是 0：重读到 ${TOP_RETRY_MS}ms 放过，记 still-0 和 skip`, () => {
    mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps({ top: 0 }));
    for (let k = 0; k < 5; k++) f.flush(TOP_RETRY_FRAMES);
    expect(pad()).toBeNull();
    clock = TOP_RETRY_MS;
    f.flush(TOP_RETRY_FRAMES);
    expect(pad()).toBeNull();
    expect(f.size).toBe(0);
    const log = readGapFixLog();
    expect(log).toMatch(/top-reread tries=6 after=1000ms top=0 still-0/);
    expect(log).toMatch(/skip gap-not-top\(gap=61 top=0\) top=0/);
  });

  it('建议 1：顶部安全区是 0、但根本没少高度（正常启动）：不重读，直接 skip', () => {
    setInner(956);
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps({ top: 0 }));
    expect(f.size).toBe(0);
    expect(readGapFixLog()).not.toMatch(/reread/);
  });

  it('滚过以后才变：记 after-scroll', () => {
    mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    clock = SCROLL_AT_MS;
    f.flush(2);
    setInner(956);
    f.flush();
    expect(pad()).toBeNull();
    expect(localStorage.getItem(OUT_KEY)).toMatch(/changed 895->956 after-scroll/);
  });

  it('正常启动（inner = 956）：只记 skip，不放垫块、不滚', () => {
    setInner(956);
    const by = vi.spyOn(window, 'scrollBy');
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    expect(pad()).toBeNull();
    expect(f.size).toBe(0);
    expect(by).not.toHaveBeenCalled();
    expect(localStorage.getItem(OUT_KEY)).toMatch(/skip no-gap\(0\)/);
  });

  it('不是主屏幕版：skip not-standalone', () => {
    mountBar();
    startGapFix(frames().frame, deps({ standalone: false }));
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/skip not-standalone/);
  });

  it(`一直没有底栏（停在设置等页）：最多等 ${WAIT_BAR_MS}ms，照样判断`, () => {
    const f = frames();
    startGapFix(f.frame, deps());
    f.flush();
    expect(pad()).toBeNull();
    clock = WAIT_BAR_MS;
    f.flush();
    expect(pad()).not.toBeNull();
  });

  it('停止函数：撤掉垫块、不再等帧；没开始就停也不放垫块', () => {
    mountBar();
    const f = frames();
    const stop = startGapFix(f.frame, deps());
    expect(pad()).not.toBeNull();
    stop();
    expect(pad()).toBeNull();
    f.flush(5);
    expect(pad()).toBeNull();
    document.body.replaceChildren();
    const g = frames();
    const stop2 = startGapFix(g.frame, deps());
    stop2();
    mountBar();
    g.flush(3);
    expect(pad()).toBeNull();
  });
});
