// 键盘收起后再做一次 Gap fix（Q-4，platform/vh-gapfix-kb.ts 经 vh-gapfix.ts 的 startGapFix 接上，11-11）：冷启动 895 → 修好 956 → 键盘 542 → 收起回 895 时再做一次、记 kb 日志；
// 条件不满足不做、连续 focusout 不叠跑、诊断页关掉不做、键盘还在不做、用户在滚不抢、停止、日志上限
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIVE_UP_MS, MAX_LINES, PAD_ID, readGapFixLog, SCROLL_AT_MS, setGapFixOn, startGapFix } from '../vh-gapfix.ts';
import { KB_SETTLE_MS } from '../vh-gapfix-kb.ts';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

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
/** 静过防抖时间再跑几帧 */
const settle = (f: { flush(n?: number): void }) => {
  clock += KB_SETTLE_MS;
  f.flush(3);
};
const mountBar = (): void => {
  const el = document.createElement('nav');
  el.dataset['testid'] = 'tabbar';
  document.body.append(el);
};
const pad = () => document.getElementById(PAD_ID);
const deps = (over: { standalone?: boolean; top?: number | (() => number) } = {}) => ({ now: () => clock, standalone: true, top: 61, ...over });

/** 假的 visualViewport：只要 height、offsetTop 和 resize 事件 */
let vvH = 895;
let vvTarget = new EventTarget();
/** 每条测试起的都在 afterEach 停掉（监听挂在 document 上，不停会串到下一条） */
const stops: Array<() => void> = [];
const start = (...a: Parameters<typeof startGapFix>): (() => void) => {
  const stop = startGapFix(...a);
  stops.push(stop);
  return stop;
};
const vvResize = (h: number) => {
  vvH = h;
  vvTarget.dispatchEvent(new Event('resize'));
};
/** innerHeight 和可视区一起变成 h（iOS 主屏幕版弹、收键盘时两个一样） */
const resize = (h: number) => {
  setInner(h);
  vvResize(h);
};

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
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
  vvH = 895;
  vvTarget = new EventTarget();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: Object.defineProperties(vvTarget, {
      height: { configurable: true, get: () => vvH },
      offsetTop: { configurable: true, value: 0 },
    }),
  });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  Reflect.deleteProperty(window, 'visualViewport');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('键盘收起后再做一次（Q-4：冷启动 895 → 修好 956 → 键盘 542 → 收起回 895）', () => {
  const input = (): HTMLInputElement => {
    const el = document.createElement('input');
    document.body.append(el);
    return el;
  };
  const kbPads = (): number => readGapFixLog().match(/kb pad /g)?.length ?? 0;
  /** 冷启动那次做完（895 → 956），然后弹键盘（542）、点空白收起（focusout，回 895） */
  const coldThenKeyboard = (f: ReturnType<typeof frames>) => {
    mountBar();
    start(f.frame, deps());
    resize(956);
    clock = 50;
    f.flush();
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/changed 895->956 by-pad pad-removed/);
    const el = input();
    el.focus();
    clock = 1000;
    resize(542);
    expect(readGapFixLog()).toMatch(/kb open vv=542/);
    clock = 4000;
    el.blur();
    resize(895);
  };

  it('收起后防抖 KB_SETTLE_MS 再做同一套：放垫块（日志带 kb）、innerHeight 回 956 就撤', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    f.flush(3);
    expect(pad()).toBeNull();
    clock = 4000 + KB_SETTLE_MS;
    f.flush();
    expect(pad()).not.toBeNull();
    expect(pad()?.style.height).toBe('calc(100dvh + 62px)');
    setInner(956);
    f.flush();
    expect(pad()).toBeNull();
    const log = readGapFixLog();
    expect(log).toMatch(/kb pad gap=61 top=61/);
    expect(log).toMatch(/kb changed 895->956 by-pad pad-removed inner=956/);
    expect(f.size).toBe(0);
  });

  it('键盘那次也会滚 1px 再滚回、到点撤；之后再来 resize 不再做（退膛，等下次键盘弹起）', () => {
    const { by, to } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    clock = 4000 + KB_SETTLE_MS;
    f.flush();
    clock += SCROLL_AT_MS;
    f.flush();
    expect(by).toHaveBeenCalledWith(0, 1);
    f.flush();
    expect(to).toHaveBeenCalledWith(0, 0);
    clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/kb scrollBy1[\s\S]*kb no-change pad-removed/);
    vvResize(895);
    settle(f);
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('连续多次 focusout / resize 不叠跑：只放一块垫块、只记一次 kb pad；做着的时候再来也不再放', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    for (let k = 0; k < 5; k++) {
      clock += 50;
      document.dispatchEvent(new FocusEvent('focusout'));
      vvResize(895);
      f.flush();
    }
    expect(pad()).toBeNull();
    settle(f);
    expect(document.querySelectorAll('#' + PAD_ID)).toHaveLength(1);
    document.dispatchEvent(new FocusEvent('focusout'));
    vvResize(895);
    settle(f);
    expect(document.querySelectorAll('#' + PAD_ID)).toHaveLength(1);
    expect(kbPads()).toBe(1);
  });

  it('键盘还在（焦点挪到另一个输入框）时不做，真收起了才做', () => {
    mockScroll();
    const f = frames();
    mountBar();
    start(f.frame, deps());
    setInner(956);
    f.flush();
    const a = input();
    a.focus();
    resize(542);
    const b = input();
    b.focus();
    settle(f);
    expect(pad()).toBeNull();
    // innerHeight 回来了但焦点还在输入框：也不做
    resize(895);
    settle(f);
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(0);
    b.blur();
    settle(f);
    expect(pad()).not.toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('条件不满足（收起后回到 956，正常）：只记 kb skip，不放垫块、不滚', () => {
    const { by } = mockScroll();
    const f = frames();
    mountBar();
    start(f.frame, deps());
    setInner(956);
    f.flush();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(956);
    settle(f);
    expect(pad()).toBeNull();
    expect(by).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/kb skip no-gap\(0\) top=61/);
  });

  it('诊断页中途关掉 Gap fix：收起后不做，记 kb skip off', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    setGapFixOn(false);
    settle(f);
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/kb skip off/);
  });

  it('冷启动那次还没做完就弹键盘又收起：不叠跑，始终最多一块垫块；冷启动那次撤了以后键盘那次接着做', () => {
    mockScroll();
    const f = frames();
    mountBar();
    start(f.frame, deps());
    expect(pad()).not.toBeNull();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    for (let k = 0; k < 4; k++) {
      clock += KB_SETTLE_MS;
      f.flush();
      expect(document.querySelectorAll('#' + PAD_ID).length).toBeLessThanOrEqual(1);
    }
    clock += GIVE_UP_MS;
    for (let k = 0; k < 6; k++) {
      clock += KB_SETTLE_MS;
      f.flush();
      expect(document.querySelectorAll('#' + PAD_ID).length).toBeLessThanOrEqual(1);
    }
    expect(kbPads()).toBe(1);
  });

  it('代码审 M1：用户正在滚（手指按着、页面被滚过），键盘那次不补 1px 滚动，只靠垫块，到点照样撤', () => {
    const { by, to } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    clock = 4000 + KB_SETTLE_MS;
    f.flush();
    expect(pad()).not.toBeNull();
    document.dispatchEvent(new Event('touchstart'));
    sy = 120;
    clock += SCROLL_AT_MS;
    f.flush();
    expect(by).not.toHaveBeenCalled();
    clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(to).not.toHaveBeenCalled();
    expect(sy).toBe(120);
    expect(readGapFixLog()).toMatch(/kb scroll-skipped user-scrolling y=120/);
  });

  it('停止函数：之后键盘起落都不理', () => {
    const f = frames();
    mountBar();
    const stop = start(f.frame, deps());
    setInner(956);
    f.flush();
    stop();
    resize(542);
    resize(895);
    settle(f);
    expect(readGapFixLog()).not.toMatch(/kb/);
    expect(pad()).toBeNull();
  });

  it('日志最多留 MAX_LINES 行，第一行（开头）一直在', () => {
    mockScroll();
    const f = frames();
    mountBar();
    start(f.frame, deps());
    setInner(956);
    f.flush();
    for (let k = 0; k < MAX_LINES; k++) {
      resize(542);
      resize(956);
      settle(f);
    }
    const log = readGapFixLog().split('\n');
    expect(log).toHaveLength(MAX_LINES);
    expect(log[0]).toMatch(/^gapfix start=/);
  });
});
