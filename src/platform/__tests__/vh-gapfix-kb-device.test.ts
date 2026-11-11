// 键盘收起后再做一次（Q-4，vh-gapfix-kb.ts）里跟设备、方向有关的几条（从 vh-gapfix-kb.test.ts 拆出来，11-11）：
// 横屏整屏取 screen 短边、不是 iPhone 不认“innerHeight 变小”、不是主屏幕版不盯
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAD_ID, readGapFixLog, startGapFix } from '../vh-gapfix.ts';
import { KB_SETTLE_MS } from '../vh-gapfix-kb.ts';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

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
/** 页面滚动位置（scrollY 读它） */
let sy = 0;
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

describe('键盘收起后再做一次：设备和方向（独立验证 11-11 采纳）', () => {
  it('横屏（innerWidth > innerHeight）整屏取 screen 短边 440：横屏本身 440 高不上膛（原来拿 956 比，横屏一直上膛）；横屏弹键盘到 200 才上膛', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(956);
    const f = frames();
    mountBar();
    start(f.frame, deps({ top: 0 }));
    resize(440);
    resize(430);
    expect(readGapFixLog()).not.toMatch(/kb open/);
    const el = document.createElement('input');
    document.body.append(el);
    el.focus();
    resize(200);
    expect(readGapFixLog()).toMatch(/kb open vv=200/);
  });

  it('不是 iPhone（iPad 的 UA 是 Macintosh）：不认“innerHeight 变小”这一条，542 不上膛（台前调度、分屏时窗口本来就矮）', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPAD_UA);
    const f = frames();
    mountBar();
    start(f.frame, deps());
    resize(542);
    resize(895);
    settle(f);
    expect(readGapFixLog()).not.toMatch(/kb/);
  });

  it('不是主屏幕版：不盯键盘', () => {
    const f = frames();
    mountBar();
    start(f.frame, deps({ standalone: false }));
    resize(542);
    resize(895);
    settle(f);
    expect(readGapFixLog()).not.toMatch(/kb/);
    expect(pad()).toBeNull();
  });
});
