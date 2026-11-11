// iOS 主屏幕版键盘把布局视口本身压矮（Q-9，viewport.ts 的主屏幕版那条、只对 iPhone）和 editableFocused（从 remind-platform.test.ts 拆出来，11-11）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboardWatcher, editableFocused, fullHeight, isIPhone } from '../viewport.ts';

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
    });
    const set = (h: number) => {
      inner = h;
      vv.height = h;
      handlers.get('resize')?.();
    };
    return { set, w, attrs, style, docH, setEditing: (v: boolean) => (editing = v) };
  };

  it('输入框聚焦、innerHeight 956→542：算键盘弹着（高 414），--kb 不写（布局视口下沿就是键盘上沿），根节点打 data-kbo；收起（回 895 或 956）恢复', () => {
    const { set, w, attrs, style } = mk();
    const fn = vi.fn();
    w.watch(fn);
    set(542);
    expect(fn).toHaveBeenLastCalledWith(true, 414);
    expect(w.isOpen()).toBe(true);
    expect(attrs.get('data-kbo')).toBe('1');
    expect(style.setProperty).not.toHaveBeenCalled();
    set(895);
    expect(fn).toHaveBeenLastCalledWith(false, 0);
    expect(attrs.has('data-kbo')).toBe(false);
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
