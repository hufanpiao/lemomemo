// iOS 主屏幕版键盘把布局视口本身压矮（Q-9，viewport.ts 的主屏幕版那条、只对 iPhone）和 editableFocused（从 remind-platform.test.ts 拆出来，11-11）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboardWatcher, editableFocused, GAP_VAR, HOLD_MS, isIPhone } from '../viewport.ts';
import { fullHeight, GAP_MAX_PX } from '../viewport-geom.ts';

describe('iOS 主屏幕版键盘把布局视口本身压矮（Q-9，负责人 preview.259：innerHeight 956→542，可视区跟着 542）', () => {
  const mk = (o: { standalone?: boolean; editing?: boolean; phone?: boolean } = {}) => {
    const handlers = new Map<string, () => void>();
    const docH = new Map<string, () => void>();
    let inner = 956;
    let editing = o.editing ?? true;
    const vv = {
      height: 956,
      offsetTop: 0,
      scale: 1,
      addEventListener: (k: string, f: () => void) => handlers.set(k, f),
      removeEventListener: (k: string) => handlers.delete(k),
    };
    const attrs = new Map<string, string>();
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const root = { style, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
    const doc = { addEventListener: (k: string, f: () => void) => docH.set(k, f), removeEventListener: (k: string) => docH.delete(k) };
    const w = createKeyboardWatcher({
      vv: () => vv as never,
      innerHeight: () => inner,
      root: () => root,
      doc: () => doc as never,
      standalone: () => o.standalone ?? true,
      editing: () => editing,
      full: () => 956,
      phone: () => o.phone ?? true,
      now: () => Date.now(),
    });
    const set = (h: number) => {
      inner = h;
      vv.height = h;
      handlers.get('resize')?.();
    };
    return { set, w, attrs, style, docH, vv, setInner: (h: number) => (inner = h), setEditing: (v: boolean) => (editing = v) };
  };

  it('输入框聚焦、innerHeight 956→542：算键盘弹着（高 414），--kb 不写（布局视口下沿就是键盘上沿），根节点打 data-kbo；收起时 data-kbo 马上拿掉，回到整屏才对订阅者报收起（Q-13）', () => {
    const { set, w, attrs, style, setEditing } = mk();
    const fn = vi.fn();
    w.watch(fn);
    set(542);
    expect(fn).toHaveBeenLastCalledWith(true, 414);
    expect(w.isOpen()).toBe(true);
    expect(attrs.get('data-kbo')).toBe('1');
    expect(style.setProperty).not.toHaveBeenCalled();
    setEditing(false);
    set(895);
    expect(fn).not.toHaveBeenCalledWith(false, 0);
    expect(w.isOpen()).toBe(true);
    expect(attrs.has('data-kbo')).toBe(false);
    set(956);
    expect(fn).toHaveBeenLastCalledWith(false, 0);
    expect(w.isOpen()).toBe(false);
  });

  it('Q-13 收起后暂缓：innerHeight 一直停在 895（Gap fix 关着等），最多 HOLD_MS 就报收起', () => {
    vi.useFakeTimers();
    try {
      const { set, w, setEditing } = mk();
      const fn = vi.fn();
      w.watch(fn);
      set(542);
      setEditing(false);
      set(895);
      expect(fn).not.toHaveBeenCalledWith(false, 0);
      vi.advanceTimersByTime(HOLD_MS - 1);
      expect(w.isOpen()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenLastCalledWith(false, 0);
      expect(w.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Q-13 暂缓只在主屏幕版 iPhone：浏览器里收键盘照旧马上报收起', () => {
    const { set, w } = mk({ standalone: false });
    const fn = vi.fn();
    w.watch(fn);
    set(542);
    set(895);
    expect(w.isOpen()).toBe(false);
  });

  it('Q-13 焊死：键盘没弹、没在输入、inner 比整屏少 5～100 才写 --vh-gap；iPad、差太多、正在输入（外接键盘快捷条）都不写', () => {
    const gapCalls = (style: { setProperty: ReturnType<typeof vi.fn> }) => style.setProperty.mock.calls.filter((c) => c[0] === GAP_VAR);
    const a = mk({ editing: false });
    a.w.watch(vi.fn());
    a.set(895);
    expect(gapCalls(a.style).at(-1)).toEqual([GAP_VAR, '61px']);
    a.set(956);
    expect(a.style.removeProperty).toHaveBeenCalledWith(GAP_VAR);
    const ipad = mk({ editing: false, phone: false });
    ipad.w.watch(vi.fn());
    ipad.set(895);
    expect(gapCalls(ipad.style)).toEqual([]);
    const far = mk({ editing: false });
    far.w.watch(vi.fn());
    far.set(956 - GAP_MAX_PX - 1);
    expect(gapCalls(far.style)).toEqual([]);
    const typing = mk({ editing: true });
    typing.w.watch(vi.fn());
    typing.set(895);
    expect(gapCalls(typing.style)).toEqual([]);
  });

  it('Q-13 暂缓期间键盘又弹起：照旧报弹着；取消订阅清掉计时器、isOpen 复位', () => {
    vi.useFakeTimers();
    try {
      const { set, w } = mk();
      const fn = vi.fn();
      const off = w.watch(fn);
      set(542);
      set(895);
      expect(w.isOpen()).toBe(true);
      const before = fn.mock.calls.length;
      set(542);
      expect(fn.mock.calls.length).toBe(before + 1);
      expect(fn).toHaveBeenLastCalledWith(true, 414);
      set(895);
      expect(vi.getTimerCount()).toBe(1);
      off();
      expect(vi.getTimerCount()).toBe(0);
      expect(w.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('冷启动那个错的 895（只差顶部安全区 61）不算键盘，哪怕输入框聚焦着', () => {
    const { set, w, attrs } = mk();
    const fn = vi.fn();
    w.watch(fn);
    set(895);
    expect(fn).not.toHaveBeenCalled();
    expect(w.isOpen()).toBe(false);
    expect(attrs.has('data-kbo')).toBe(false);
  });

  it('没有输入框聚焦（比如 iPad 分屏窗口变矮）不算；focusout 时重算，焦点走了就收', () => {
    const { set, w, docH, setEditing } = mk({ editing: false });
    const fn = vi.fn();
    w.watch(fn);
    set(542);
    expect(w.isOpen()).toBe(false);
    setEditing(true);
    docH.get('focusin')?.();
    expect(w.isOpen()).toBe(true);
    setEditing(false);
    docH.get('focusout')?.();
    // Q-13：焦点走了、但布局视口还没回到整屏，先暂缓（底栏继续藏）；回到整屏才报收起
    expect(w.isOpen()).toBe(true);
    set(956);
    expect(w.isOpen()).toBe(false);
    expect(fn).toHaveBeenLastCalledWith(false, 0);
  });

  it('不是 iPhone（iPad 台前调度、分屏、接实体键盘时窗口本来就矮）：不走这条，照旧只看可视区', () => {
    const { set, w, attrs } = mk({ phone: false });
    w.watch(vi.fn());
    set(542);
    expect(w.isOpen()).toBe(false);
    expect(attrs.has('data-kbo')).toBe(false);
  });

  it('fullHeight 按横竖取 screen 长边、短边；isIPhone 只认 iPhone、iPod', () => {
    const screen = { width: 440, height: 956 };
    expect(fullHeight({ innerWidth: 440, innerHeight: 542, screen })).toBe(956);
    expect(fullHeight({ innerWidth: 956, innerHeight: 200, screen })).toBe(440);
    expect(fullHeight({ innerWidth: 956, innerHeight: 440, screen: { width: 956, height: 440 } })).toBe(440);
    // 小屏竖屏弹键盘（375×667，键盘+辅助条后 innerHeight≈363 < 宽 375）：仍是竖屏，取 667（独立验证 11-11 必改 2）
    expect(fullHeight({ innerWidth: 375, innerHeight: 363, screen: { width: 375, height: 667 } })).toBe(667);
    expect(isIPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(isIPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
  });

  it('不是主屏幕版（浏览器里）不走这条，照旧只看可视区比布局视口少多少', () => {
    const { set, w } = mk({ standalone: false });
    w.watch(vi.fn());
    set(542);
    expect(w.isOpen()).toBe(false);
  });

  it('浏览器那种（布局视口不变、可视区变小）照旧写 --kb，也打 data-kbo', () => {
    const attrs = new Map<string, string>();
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const handlers = new Map<string, () => void>();
    const vv = { height: 800, offsetTop: 0, addEventListener: (k: string, f: () => void) => handlers.set(k, f), removeEventListener: (k: string) => handlers.delete(k) };
    const root = { style, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
    const b = createKeyboardWatcher({ vv: () => vv as never, innerHeight: () => 800, root: () => root, standalone: () => false });
    b.watch(vi.fn());
    vv.height = 480;
    handlers.get('resize')?.();
    expect(style.setProperty).toHaveBeenCalledWith('--kb', '320px');
    expect(attrs.get('data-kbo')).toBe('1');
    vv.height = 800;
    handlers.get('resize')?.();
    expect(attrs.has('data-kbo')).toBe(false);
  });
  it('负责人 11-11“底栏焊死在下面不动”：可视区被滚下去（inner=941、vv=542、top=399，量出键盘 0）时，只要光标在输入框里照样算弹着、打 data-kbo；离开输入框才报收起', () => {
    const { w, attrs, docH, setEditing, vv, setInner } = mk();
    const fn = vi.fn();
    w.watch(fn);
    setInner(941);
    vv.height = 542;
    vv.offsetTop = 399;
    docH.get('focusin')?.();
    expect(w.isOpen()).toBe(true);
    expect(attrs.get('data-kbo')).toBe('1');
    expect(fn).toHaveBeenLastCalledWith(true, 0);
    setEditing(false);
    docH.get('focusout')?.();
    expect(attrs.has('data-kbo')).toBe(false);
    expect(w.isOpen()).toBe(false);
  });

  it('光标在输入框里就藏底栏只在主屏幕版 iPhone：浏览器里、非 iPhone 照旧按量出来的高度', () => {
    for (const o of [{ standalone: false }, { phone: false }]) {
      const { w, attrs, docH, vv, setInner } = mk(o);
      w.watch(vi.fn());
      setInner(941);
      vv.height = 542;
      vv.offsetTop = 399;
      docH.get('focusin')?.();
      expect(w.isOpen()).toBe(false);
      expect(attrs.has('data-kbo')).toBe(false);
    }
  });
});

describe('editableFocused：哪些聚焦会弹键盘', () => {
  afterEach(() => document.body.replaceChildren());
  it('文字 input、textarea、可编辑元素算；按钮、复选框、没聚焦不算', () => {
    expect(editableFocused()).toBe(false);
    const mkEl = (tag: string, type?: string): HTMLElement => {
      const el = document.createElement(tag);
      if (type) el.setAttribute('type', type);
      document.body.append(el);
      el.focus();
      return el;
    };
    mkEl('input', 'text');
    expect(editableFocused()).toBe(true);
    mkEl('textarea');
    expect(editableFocused()).toBe(true);
    mkEl('input', 'checkbox');
    expect(editableFocused()).toBe(false);
    mkEl('button');
    expect(editableFocused()).toBe(false);
  });
});
