// 焦点在、键盘却不在（platform/viewport.ts 文件头“例外（11-21）”）：负责人录屏——取消原生选图菜单后一秒内点随手记输入框，
// iOS 弹完键盘 0.1～0.4 秒又自己收掉、不发 focusout，模糊层一直开着；再点一下系统为露出输入框把页面滚上去（日志 vv top=413 y=541）。
// • 原地聚焦过的输入框，键盘弹起过又收掉、焦点还在：替它 blur（后台切走不动）
// • iPhone 上已聚焦、键盘不在的一下点：按没聚焦处理（拦默认、原地聚焦、光标放末尾）；键盘弹着照原生
// 单独一个文件：共用的键盘监听第一次订阅时读 visualViewport，要先装好假的
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, isKeyboardUp, startViewport, type InPlaceTouch } from '../viewport.ts';

class FakeVv extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
}
const vv = new FakeVv();

/** 键盘弹到 px 高（0 = 收起），派发 resize */
const setKb = (px: number): void => {
  vv.height = window.innerHeight - px;
  vv.dispatchEvent(new Event('resize'));
};

const mkInput = (value = '买牛奶'): HTMLInputElement => {
  const el = document.createElement('input');
  el.value = value;
  document.body.append(el);
  return el;
};

const touch = (el: EventTarget, t: number): InPlaceTouch & { prevented: boolean } => {
  const e = {
    currentTarget: el,
    changedTouches: [{ clientX: 100, clientY: 200 }],
    timeStamp: t,
    cancelable: true,
    prevented: false,
    preventDefault(): void {
      e.prevented = true;
    },
  };
  return e;
};
const tap = (el: HTMLInputElement) => {
  inPlaceTouchStart(touch(el, 1000));
  const up = touch(el, 1080);
  inPlaceTouchEnd(up);
  return up;
};

beforeAll(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  startViewport();
});

describe('焦点在、键盘不在（11-21 附件取消后输入框下坠）', () => {
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    setKb(0);
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('原地聚焦过、键盘弹起又被系统收掉：替它 blur', () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(300);
    expect(isKeyboardUp()).toBe(true);
    expect(document.activeElement).toBe(el);
    setKb(0);
    expect(isKeyboardUp()).toBe(false);
    expect(document.activeElement).not.toBe(el);
  });

  it('键盘还没弹起过（聚焦后视口还没变）：不 blur', () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(0);
    expect(document.activeElement).toBe(el);
  });

  it('后台切走（不可见）时键盘收掉：不 blur，回来系统自己弹回键盘', () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(300);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    setKb(0);
    expect(document.activeElement).toBe(el);
  });

  it('自己 blur 以后不再盯：下一次键盘起落不碰别的输入框', () => {
    const a = mkInput();
    const b = mkInput();
    focusInPlace(a, 'tap');
    a.blur();
    b.focus();
    setKb(300);
    setKb(0);
    expect(document.activeElement).toBe(b);
  });

  const asIPhone = (): void => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)');
  };

  it('iPhone 上原地聚焦后键盘一直没弹：点一下拦掉默认、重聚焦、光标放末尾；只重试一次，再点照原生（接实体键盘本来就不弹）', () => {
    asIPhone();
    const el = mkInput('买牛奶');
    focusInPlace(el, 'tap');
    el.setSelectionRange(0, 0);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const up = tap(el);
    expect(up.prevented).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(el);
    expect([el.selectionStart, el.selectionEnd]).toEqual([3, 3]);
    expect(tap(el).prevented).toBe(false);
  });

  it('键盘弹起又被系统收掉以后：已 blur，下一下点是没聚焦的点，照原地聚焦', () => {
    asIPhone();
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(300);
    setKb(0);
    expect(tap(el).prevented).toBe(true);
    expect(document.activeElement).toBe(el);
  });

  it('iPhone 上已聚焦、键盘弹着：照原生（不拦，点哪里光标去哪里）', () => {
    asIPhone();
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(300);
    expect(tap(el).prevented).toBe(false);
  });

  it('不是原地聚焦来的焦点（没 trackFocus）：已聚焦照原生', () => {
    asIPhone();
    const el = mkInput();
    el.focus();
    expect(tap(el).prevented).toBe(false);
  });

  it('不是 iPhone：已聚焦照原生', () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    expect(tap(el).prevented).toBe(false);
  });

  it('焦点还在时输入框被卸掉：下一次键盘事件就不再盯（不泄漏）', () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    el.remove();
    setKb(300);
    const again = mkInput();
    document.body.append(el);
    el.focus();
    setKb(0);
    expect(document.activeElement).toBe(el);
    again.remove();
  });
});
