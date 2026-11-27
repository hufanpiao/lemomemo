// viewport.ts 的藏底栏属性（BAR_HIDE_ATTR = data-kbo 或收起后暂缓）和停止监听时复位、“布局视口还少一截”写 --vh-gap 把贴底元素补到屏幕底
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RL_SLOT } from '../run-log-api.ts';
import { BAR_HIDE_ATTR } from '../viewport-geom.ts';
import { createKeyboardWatcher, HOLD_MS } from '../viewport.ts';

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
  /** 键盘压在布局视口上（浏览器里那种：innerHeight 不变、可视区变矮 h） */
  const cover = (h: number) => {
    editing = true;
    vv.height = inner - h;
    handlers.get('resize')?.();
  };
  return { w, set, up, down, wait, cover, root, hidden: () => attrs.get(BAR_HIDE_ATTR) === '1', kbo: () => attrs.has('data-kbo') };
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

describe('布局视口少一截：--vh-gap 把贴底元素补到屏幕底', () => {
  it('键盘没弹时 895 / 956：写 --vh-gap 61px、记 gapfix short=61；回到整屏拿掉、记 short=0；只在值变了时记', () => {
    const got: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const old = g[RL_SLOT];
    g[RL_SLOT] = { q: [], sink: (l: string) => got.push(l) };
    try {
      const k = mk();
      k.set(895);
      const stop = k.w.watch(() => undefined);
      k.set(895);
      expect(k.root.style.setProperty).toHaveBeenCalledWith('--vh-gap', '61px');
      k.set(956);
      expect(k.root.style.removeProperty).toHaveBeenCalledWith('--vh-gap');
      expect(got.filter((l) => l.startsWith('gapfix '))).toEqual(['gapfix short=61', 'gapfix short=0']);
      stop();
    } finally {
      g[RL_SLOT] = old;
    }
  });

  it('负责人 11-26 真机：待办备注键盘弹到一半就滑回今天页，收完停在 906（少 50，不是顶部安全区）：--vh-gap 50px，底栏补回原位', () => {
    const k = mk();
    const stop = k.w.watch(() => undefined);
    k.up();
    k.down(906);
    expect(k.root.style.setProperty).toHaveBeenCalledWith('--vh-gap', '50px');
    stop();
    expect(k.root.style.removeProperty).toHaveBeenCalledWith('--vh-gap');
  });
});

describe('停止监听时写到根节点的值跟着复位', () => {
  it('键盘弹着时停：写到根节点的三样（--kb、data-kbo、data-kbhide）一起拿掉，isOpen 归 false；再订阅照量出来的重新写', () => {
    const k = mk();
    const stop = k.w.watch(() => undefined);
    k.cover(300);
    expect(k.root.style.setProperty).toHaveBeenCalledWith('--kb', '300px');
    expect(k.kbo() && k.hidden() && k.w.isOpen()).toBe(true);
    stop();
    expect(k.root.style.removeProperty).toHaveBeenCalledWith('--kb');
    expect(k.kbo() || k.hidden() || k.w.isOpen()).toBe(false);
    k.root.style.setProperty.mockClear();
    const again = k.w.watch(() => undefined);
    expect(k.root.style.setProperty).toHaveBeenCalledWith('--kb', '300px');
    expect(k.kbo() && k.hidden()).toBe(true);
    again();
  });
});
