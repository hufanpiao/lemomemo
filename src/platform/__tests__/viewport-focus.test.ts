// 贴底浮条输入框原地聚焦（platform/viewport.ts 的 focusInPlace、inPlaceTouchStart / inPlaceTouchEnd；台账 Q-8）：
// 没聚焦时的一下“点”拦掉默认、原地聚焦（focus 带 preventScroll）、光标放末尾；拦不了、已经聚焦、拖动、长按都不管，照原生行为。
// keepFieldFocus（台账 Q-25）：浮条里按钮上的 mousedown 拦掉默认（输入框不失焦），输入框上的不拦
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus, TAP_HOLD_MS, TAP_SLOP_PX, type InPlaceTouch } from '../viewport.ts';

const mkInput = (value = '买牛奶'): HTMLInputElement => {
  const el = document.createElement('input');
  el.value = value;
  document.body.append(el);
  return el;
};

/** 一次触摸事件（React 的触摸事件和原生 TouchEvent 合用的那几个字段） */
const touch = (el: EventTarget, x: number, y: number, t: number, cancelable = true): InPlaceTouch & { prevented: boolean } => {
  const e = {
    currentTarget: el,
    changedTouches: [{ clientX: x, clientY: y }],
    timeStamp: t,
    cancelable,
    prevented: false,
    preventDefault(): void {
      e.prevented = true;
    },
  };
  return e;
};

/** 按下再抬起；返回抬起那一下 */
const tap = (el: HTMLInputElement, o: { dx?: number; ms?: number; cancelable?: boolean } = {}) => {
  inPlaceTouchStart(touch(el, 100, 200, 1000));
  const up = touch(el, 100 + (o.dx ?? 0), 200, 1000 + (o.ms ?? 80), o.cancelable ?? true);
  inPlaceTouchEnd(up);
  return up;
};

describe('贴底浮条输入框原地聚焦（Q-8）', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('focusInPlace：先读 offsetHeight 排完版面，再 focus 带 preventScroll；没有元素什么都不做', () => {
    const el = mkInput();
    const calls: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => {
      calls.push('layout');
      return 40;
    });
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation((o?: FocusOptions) => {
      calls.push(`focus preventScroll=${String(o?.preventScroll)}`);
    });
    focusInPlace(el, 'open');
    focusInPlace(null, 'open');
    expect(calls).toEqual(['layout', 'focus preventScroll=true']);
  });

  it('没聚焦时的一下点：拦掉默认、原地聚焦、光标放到末尾', () => {
    const el = mkInput('买牛奶');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const up = tap(el);
    expect(up.prevented).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(el);
    expect([el.selectionStart, el.selectionEnd]).toEqual([3, 3]);
  });

  it('已经聚焦着：不拦，点哪里光标去哪里', () => {
    const el = mkInput();
    el.focus();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    expect(tap(el).prevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('拦不了（cancelable=false，例如正在滚动）：不管', () => {
    const el = mkInput();
    expect(tap(el, { cancelable: false }).prevented).toBe(false);
    expect(document.activeElement).not.toBe(el);
  });

  it('拖动：挪了 TAP_SLOP_PX 以上不拦；差一点的照样算点', () => {
    const el = mkInput();
    expect(tap(el, { dx: TAP_SLOP_PX }).prevented).toBe(false);
    expect(document.activeElement).not.toBe(el);
    expect(tap(el, { dx: TAP_SLOP_PX - 1 }).prevented).toBe(true);
  });

  it('长按：按住 TAP_HOLD_MS 以上不拦（iOS 放大镜、选字照原生）；差一点的照样算点', () => {
    const el = mkInput();
    expect(tap(el, { ms: TAP_HOLD_MS }).prevented).toBe(false);
    expect(document.activeElement).not.toBe(el);
    expect(tap(el, { ms: TAP_HOLD_MS - 1 }).prevented).toBe(true);
  });

  it('没有按下记录（touchstart 没到这个输入框）：不管；一次按下只认一次抬起', () => {
    const el = mkInput();
    const up = touch(el, 100, 200, 1000);
    inPlaceTouchEnd(up);
    expect(up.prevented).toBe(false);
    inPlaceTouchStart(touch(el, 100, 200, 1000));
    inPlaceTouchEnd(touch(el, 100, 200, 1050));
    el.blur();
    const again = touch(el, 100, 200, 1100);
    inPlaceTouchEnd(again);
    expect(again.prevented).toBe(false);
  });
});

describe('keepFieldFocus（台账 Q-25）', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });
  /** 在 el 上按下鼠标（真的 MouseEvent，冒泡到挂着 keepFieldFocus 的 form）；返回有没有被拦 */
  const down = (el: Element): boolean => {
    const form = el.closest('form');
    form?.addEventListener('mousedown', keepFieldFocus);
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    form?.removeEventListener('mousedown', keepFieldFocus);
    return e.defaultPrevented;
  };
  const mkBar = (): { form: HTMLFormElement; field: HTMLInputElement; button: HTMLButtonElement; label: HTMLSpanElement } => {
    const form = document.createElement('form');
    const field = document.createElement('input');
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    form.append(field, button);
    document.body.append(form);
    return { form, field, button, label };
  };

  it('按钮上按下（包括按钮里的字）：拦掉默认，输入框不失焦', () => {
    const { button, label } = mkBar();
    expect(down(button)).toBe(true);
    expect(down(label)).toBe(true);
  });

  it('输入框上按下：不拦，照原生行为放光标、选字（文本框同样）', () => {
    const { form, field } = mkBar();
    expect(down(field)).toBe(false);
    const area = document.createElement('textarea');
    form.append(area);
    expect(down(area)).toBe(false);
  });

  it('浮条里的空白处按下也拦（不是输入框本身就拦，焦点留在输入框）', () => {
    const { form } = mkBar();
    expect(down(form)).toBe(true);
  });
});
