// 收键盘那次校正走线上的默认接法（不传 kbClosed：viewport.ts 的共享 watcher，phone 看 UA、整屏用 fullHeight(window)、主屏幕版看 navigator.standalone），
// 一路从假的 window.visualViewport 测到放垫块：冷启动 895 → 956 → 聚焦弹到 542 → 收起回 895 → 静了 KB_SETTLE_MS 记 kb pad；
// 设备和方向：横屏整屏取 screen 短边（440 高不上膛、弹到 200 才上膛），iPad（UA 是 Macintosh）542 不上膛。
// 已知的时机变化：共享 watcher 在 vh-gapfix 订阅时（冷启动、分包加载时）就开始监听、写根节点 --vh-gap，不等 App 调 startViewport
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAP_VAR, KB_SETTLE_MS } from '../viewport.ts';
import { readGapFixLog, startGapFix } from '../vh-gapfix.ts';
import { deps, frames, input, mountBar, pad, settle, st } from './gapfix-fixture.ts';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/** 挂到 window.visualViewport 上的假对象：记着挂了几个监听（停了以后必须是 0） */
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
const vv = {
  get height() {
    return st.vvH;
  },
  offsetTop: 0,
  addEventListener: (k: string, f: EventListenerOrEventListenerObject) => listeners.set(k, (listeners.get(k) ?? new Set()).add(f)),
  removeEventListener: (k: string, f: EventListenerOrEventListenerObject) => listeners.get(k)?.delete(f),
};
const listening = (): number => [...listeners.values()].reduce((n, s) => n + s.size, 0);
/** innerHeight 和可视区一起变成 h（iOS 主屏幕版弹、收键盘时两个一样） */
const resize = (h: number) => {
  st.inner = st.vvH = h;
  for (const f of listeners.get('resize') ?? []) (typeof f === 'function' ? f : f.handleEvent)(new Event('resize'));
};
/** 默认接法：不传 kbClosed。停止函数自己收着（after 钩子按注册的倒序跑，本文件的比夹具的先跑） */
const stops: Array<() => void> = [];
const start = (f: ReturnType<typeof frames>): void => {
  stops.push(startGapFix(f.frame, deps()));
};

beforeEach(() => {
  listeners.clear();
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  // 共享 watcher 跟着最后一个订阅停了：假 visualViewport 上不剩监听
  expect(listening()).toBe(0);
  Reflect.deleteProperty(window, 'visualViewport');
  Reflect.deleteProperty(navigator, 'standalone');
  document.documentElement.style.removeProperty(GAP_VAR);
});

describe('收键盘那次校正：默认接法（共享 watcher + 假 visualViewport + iPhone UA）', () => {
  it('已知时机变化：vh-gapfix 一订阅（startViewport 以前）根节点就写了 --vh-gap', () => {
    start(frames());
    expect(listening()).toBeGreaterThan(0);
    expect(document.documentElement.style.getPropertyValue(GAP_VAR)).toBe('61px');
  });

  it('冷启动 895 → 956，聚焦弹到 542，收起回 895，静了 KB_SETTLE_MS 记 kb pad', () => {
    const f = frames();
    mountBar();
    start(f);
    expect(pad()).not.toBeNull();
    resize(956);
    f.flush();
    expect(pad()).toBeNull();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    vi.advanceTimersByTime(KB_SETTLE_MS - 1);
    expect(pad()).toBeNull();
    settle();
    expect(pad()).not.toBeNull();
    expect(readGapFixLog()).toMatch(/kb pad gap=61 top=61/);
  });

  it('横屏（innerWidth 956、screen 440×956）整屏取短边 440：本身 440 高不上膛；弹键盘到 200 才上膛，收起后 kb skip landscape', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(956);
    st.inner = st.vvH = 440;
    const f = frames();
    mountBar();
    start(f);
    resize(430);
    settle();
    expect(readGapFixLog()).not.toMatch(/kb /);
    const el = input();
    el.focus();
    resize(200);
    el.blur();
    resize(430);
    settle();
    expect(readGapFixLog()).toMatch(/kb skip landscape/);
    expect(pad()).toBeNull();
  });

  it('iPad（UA 是 Macintosh）：不认“innerHeight 变小”，聚焦 542 不上膛，收起后不做 kb', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPAD_UA);
    const f = frames();
    mountBar();
    start(f);
    resize(956);
    f.flush();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    settle();
    expect(readGapFixLog()).not.toMatch(/kb /);
    expect(pad()).toBeNull();
  });
});
