// vh-gapfix*.test.ts 共用的替身和小工具（原来每个测试文件各抄一份，11-11 视口几何返修收到这里，不含用例）。
// 主屏幕版 iPhone 竖屏冷启动：innerHeight 895、screen 440×956；帧手动推进；时钟、滚动位置、innerHeight 放在 st 上，测试直接改。
// 收键盘那次另有假的 visualViewport（vvResize / resize）和注入的键盘 watcher（startKb，不走共享 watcher；走默认接法的见 vh-gapfix-kb-device.test.ts）。
// 每条测试之前、之后的复位也在这里（beforeEach / afterEach 注册到 import 它的那个测试文件）；setTimeout 一律假的，settle() 推进
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createKeyboardWatcher, KB_SETTLE_MS } from '../viewport.ts';
import { readGapFixLog, startGapFix, type GapFixDeps } from '../vh-gapfix.ts';
import { PAD_ID, type Frame } from '../vh-gapfix-gate.ts';

/** 手动推进的“帧” */
export function frames() {
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

/** 每条测试会改的状态：innerHeight、假时钟（startGapFix 的 now）、页面滚动位置（scrollBy / scrollTo 的替身改它）、可视区高 */
export const st = { inner: 895, clock: 0, sy: 0, vvH: 895 };
export const setInner = (h: number): void => {
  st.inner = h;
};
export const mockScroll = () => ({
  by: vi.spyOn(window, 'scrollBy').mockImplementation(((_x: number, y: number) => {
    st.sy += y;
  }) as typeof window.scrollBy),
  to: vi.spyOn(window, 'scrollTo').mockImplementation(((_x: number, y: number) => {
    st.sy = y;
  }) as typeof window.scrollTo),
});
export const mountBar = (): HTMLElement => {
  const el = document.createElement('nav');
  el.dataset['testid'] = 'tabbar';
  document.body.append(el);
  return el;
};
export const pad = (): HTMLElement | null => document.getElementById(PAD_ID);
export const input = (): HTMLInputElement => document.body.appendChild(document.createElement('input'));
export const deps = (over: Partial<GapFixDeps> = {}): GapFixDeps => ({ now: () => st.clock, standalone: true, top: 61, ...over });
/** 视口和焦点静过 KB_SETTLE_MS（watcher 的计时器用假时钟） */
export const settle = (): void => {
  st.clock += KB_SETTLE_MS;
  vi.advanceTimersByTime(KB_SETTLE_MS);
};

/** 假的 visualViewport：只要 height、offsetTop 和 resize 事件 */
let vvTarget = new EventTarget();
export const vvResize = (h: number): void => {
  st.vvH = h;
  vvTarget.dispatchEvent(new Event('resize'));
};
/** innerHeight 和可视区一起变成 h（iOS 主屏幕版弹、收键盘时两个一样） */
export const resize = (h: number): void => {
  setInner(h);
  vvResize(h);
};
/** 每条测试起的都在 afterEach 停掉（监听挂在 document 上，不停会串到下一条） */
const stops: Array<() => void> = [];
export const keepStop = (stop: () => void): (() => void) => {
  stops.push(stop);
  return stop;
};
/** 注入主屏幕版 iPhone（整屏 956）键盘 watcher 的 startGapFix */
export const startKb = (frame: Frame, over: Partial<GapFixDeps> = {}): (() => void) => {
  const w = createKeyboardWatcher({
    vv: () => vvTarget as unknown as VisualViewport,
    innerHeight: () => st.inner,
    root: () => null,
    doc: () => document,
    standalone: () => true,
    full: () => 956,
    phone: () => true,
    now: () => st.clock,
  });
  return keepStop(startGapFix(frame, deps({ kbClosed: w.onClosed, ...over })));
};
/** 冷启动那次做完（895 → 956），然后弹键盘（542）、点空白收起（focusout，回 895） */
export const coldThenKeyboard = (f: ReturnType<typeof frames>): void => {
  mountBar();
  startKb(f.frame);
  resize(956);
  st.clock = 50;
  f.flush();
  expect(pad()).toBeNull();
  expect(readGapFixLog()).toMatch(/changed 895->956 by-pad pad-removed/);
  const el = input();
  el.focus();
  st.clock = 1000;
  resize(542);
  st.clock = 4000;
  el.blur();
  resize(895);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  Object.assign(st, { inner: 895, clock: 0, sy: 0, vvH: 895 });
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => st.sy);
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => st.inner);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(440);
  vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
  vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
  vvTarget = new EventTarget();
  Object.defineProperties(vvTarget, { height: { configurable: true, get: () => st.vvH }, offsetTop: { configurable: true, value: 0 } });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
