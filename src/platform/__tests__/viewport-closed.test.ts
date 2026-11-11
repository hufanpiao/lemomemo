// viewport.ts 的藏底栏属性（BAR_HIDE_ATTR = data-kbo 或收起后暂缓）和“键盘真收了”通知（onClosed，冷启动高度校正用）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAR_HIDE_ATTR, createKeyboardWatcher, HOLD_MS, KB_SETTLE_MS } from '../viewport.ts';

/** 主屏幕版 iPhone（整屏 956）：up() 聚焦弹键盘（542），down(h, editing) 收到 h */
const mk = () => {
  const handlers = new Map<string, () => void>();
  let inner = 956;
  let editing = false;
  let clock = 0;
  const vv = { height: 956, offsetTop: 0, addEventListener: (k: string, f: () => void) => handlers.set(k, f), removeEventListener: (k: string) => handlers.delete(k) };
  const attrs = new Map<string, string>();
  const root = { style: { setProperty: vi.fn(), removeProperty: vi.fn() }, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
  const w = createKeyboardWatcher({ vv: () => vv as never, innerHeight: () => inner, root: () => root, doc: () => null, standalone: () => true, editing: () => editing, full: () => 956, phone: () => true, now: () => clock });
  const set = (h: number) => {
    inner = vv.height = h;
    handlers.get('resize')?.();
  };
  const down = (h: number, stillEditing = false) => {
    editing = stillEditing;
    set(h);
  };
  const up = () => down(542, true);
  const wait = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  return { w, set, up, down, wait, hidden: () => attrs.get(BAR_HIDE_ATTR) === '1', kbo: () => attrs.has('data-kbo') };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe(`根节点 ${BAR_HIDE_ATTR}（底栏、“＋”藏起的唯一开关）`, () => {
  it('键盘弹着就打上；收起后 data-kbo 马上拿掉，暂缓期间仍藏，回到整屏才拿掉', () => {
    const k = mk();
    const stop = k.w.watch(() => undefined);
    expect(k.hidden()).toBe(false);
    k.up();
    expect(k.hidden() && k.kbo()).toBe(true);
    k.down(895);
    expect(k.kbo()).toBe(false);
    expect(k.hidden()).toBe(true);
    k.set(956);
    expect(k.hidden()).toBe(false);
    stop();
  });

  it('一直停在 895：最多 HOLD_MS 就拿掉；停止监听时暂缓作废、属性跟着拿掉', () => {
    const k = mk();
    const stop = k.w.watch(() => undefined);
    k.up();
    k.down(895);
    k.wait(HOLD_MS - 1);
    expect(k.hidden()).toBe(true);
    k.wait(1);
    expect(k.hidden()).toBe(false);
    k.up();
    k.down(895);
    expect(k.hidden()).toBe(true);
    stop();
    expect(k.hidden()).toBe(false);
  });
});

describe('onClosed（键盘真收了）', () => {
  it('收起后静了 KB_SETTLE_MS 才报一次；没再弹键盘就不再报', () => {
    const k = mk();
    const fn = vi.fn();
    const stop = k.w.onClosed(fn);
    k.up();
    k.down(895);
    k.wait(KB_SETTLE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    k.wait(1);
    expect(fn).toHaveBeenCalledTimes(1);
    k.set(956);
    k.wait(KB_SETTLE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('没弹过键盘（冷启动 895 → 956）不报', () => {
    const k = mk();
    const fn = vi.fn();
    const stop = k.w.onClosed(fn);
    k.set(895);
    k.set(956);
    k.wait(KB_SETTLE_MS);
    expect(fn).not.toHaveBeenCalled();
    stop();
  });

  it('焦点还在输入框、或布局视口还矮着一大截（还在往下收）：不报；离开输入框、回到只少顶部安全区才报', () => {
    const k = mk();
    const fn = vi.fn();
    const stop = k.w.onClosed(fn);
    k.up();
    k.down(895, true);
    k.wait(KB_SETTLE_MS);
    k.down(542);
    k.wait(KB_SETTLE_MS);
    expect(fn).not.toHaveBeenCalled();
    k.down(895);
    k.wait(KB_SETTLE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('取消订阅后计时器作废', () => {
    const k = mk();
    const fn = vi.fn();
    const stop = k.w.onClosed(fn);
    k.up();
    k.down(895);
    stop();
    k.wait(KB_SETTLE_MS);
    expect(fn).not.toHaveBeenCalled();
  });
});
