// 焦点在、键盘却不在（platform/viewport.ts 文件头“例外（11-21）”）：负责人录屏——取消原生选图菜单后一秒内点随手记输入框，
// iOS 弹完键盘 0.1～0.4 秒又自己收掉、不发 focusout，模糊层一直开着；再点一下系统为露出输入框把页面滚上去（日志 vv top=413 y=541）。
// • 463 日志定根因：iOS 收键盘只发 blur、不发 focusout，焦点还留着（React onBlur 认 focusout，模糊层不关）——原地聚焦过的输入框下一拍替它真 blur
// • iPhone 上原地聚焦后键盘一直没弹的一下点：重聚焦一次（拦默认、光标放末尾）；键盘弹着、重试过、不是原地聚焦来的照原生
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

  /** iOS 收键盘：只派发 blur，焦点还留在输入框上（不发 focusout） */
  const phantomBlur = (el: HTMLElement): void => {
    el.dispatchEvent(new FocusEvent('blur'));
  };

  it('假失焦第一次：当场真 blur 再聚焦（试着留住键盘）；700ms 后键盘还在就留着', () => {
    vi.useFakeTimers();
    const el = mkInput();
    focusInPlace(el, 'tap');
    let out = 0;
    el.addEventListener('focusout', () => (out += 1));
    phantomBlur(el);
    expect(out).toBe(1);
    expect(document.activeElement).toBe(el);
    setKb(300);
    vi.advanceTimersByTime(700);
    expect(document.activeElement).toBe(el);
    vi.useRealTimers();
  });

  it('假失焦第一次、重聚焦后键盘没回来：700ms 后真 blur（focusout 照发，模糊层关）；同一次聚焦再来假失焦直接真 blur', () => {
    vi.useFakeTimers();
    const el = mkInput();
    focusInPlace(el, 'tap');
    phantomBlur(el);
    vi.advanceTimersByTime(700);
    expect(document.activeElement).not.toBe(el);
    const b = mkInput();
    focusInPlace(b, 'tap');
    setKb(300);
    phantomBlur(b);
    vi.advanceTimersByTime(700);
    phantomBlur(b);
    vi.advanceTimersByTime(1);
    expect(document.activeElement).not.toBe(b);
    vi.useRealTimers();
  });

  it('真失焦（焦点已经走了）：不再盯，之后同一个输入框普通聚焦、假 blur 都不动它', async () => {
    const el = mkInput();
    focusInPlace(el, 'tap');
    el.blur();
    await new Promise((r) => setTimeout(r, 5));
    el.focus();
    phantomBlur(el);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(el);
  });

  it('没经过原地聚焦的输入框：假 blur 不管', async () => {
    const el = mkInput();
    el.focus();
    phantomBlur(el);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(el);
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

  it('重聚焦自己发的 blur 不当成假失焦：重聚焦后焦点留着', async () => {
    asIPhone();
    const el = mkInput();
    focusInPlace(el, 'tap');
    expect(tap(el).prevented).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(el);
  });

  it('iPhone 上已聚焦、键盘弹着：照原生（不拦，点哪里光标去哪里）', () => {
    asIPhone();
    const el = mkInput();
    focusInPlace(el, 'tap');
    setKb(300);
    expect(isKeyboardUp()).toBe(true);
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
});
