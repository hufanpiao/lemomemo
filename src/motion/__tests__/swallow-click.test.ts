// swallowNextClick（审查“吞点按五套”合成一套）：吞一次、只吞元素里的、过时限不吞、新的按下和 pointercancel 作废；
// 键盘的 click（前面有 keydown）不吞（R-420 审查第 12 条）；时限只有一个默认值 TAP_SWALLOW_MS，只靠 setTimeout 过期（假钟）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swallowNextClick } from '../swallow-click.ts';
import { TAP_SWALLOW_MS } from '../tokens.ts';

/** 手指、鼠标的 click：detail 1；键盘回车、空格：detail 0 */
const click = (el: Element, detail = 1): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
const down = (el: Element): void => void el.dispatchEvent(new Event('pointerdown', { bubbles: true }));

function setup() {
  const box = document.createElement('div');
  const inner = document.createElement('button');
  box.append(inner);
  const other = document.createElement('button');
  document.body.append(box, other);
  return { box, inner, other };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('swallowNextClick', () => {
  it('只吞元素里的第一下；落在别处的照常、也不作废', () => {
    const { box, inner, other } = setup();
    swallowNextClick({ within: box });
    expect(click(other)).toBe(true);
    expect(click(inner)).toBe(false);
    expect(click(inner)).toBe(true);
  });

  it('不给元素：落在哪儿都吞（一次）', () => {
    const { other } = setup();
    swallowNextClick({});
    expect(click(other)).toBe(false);
    expect(click(other)).toBe(true);
  });

  it('时限只有一个默认值（能盖住原来翻页 600、按住“＋”800、换页守卫 1000 三处）：到点之前吞，过了不吞', () => {
    expect(TAP_SWALLOW_MS).toBe(1000);
    const a = setup();
    swallowNextClick({ within: a.box });
    vi.advanceTimersByTime(TAP_SWALLOW_MS - 1);
    expect(click(a.inner)).toBe(false);
    swallowNextClick({ within: a.box });
    vi.advanceTimersByTime(TAP_SWALLOW_MS);
    expect(click(a.inner)).toBe(true);
  });

  it('键盘的 click（先 keydown，回车、空格）不吞；页面里派发、detail 为 0 但前面没有 keydown 的照样当补来的那一下吞', () => {
    const { box, inner } = setup();
    swallowNextClick({ within: box });
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(click(inner, 0)).toBe(true);
    swallowNextClick({ within: box });
    expect(click(inner, 0)).toBe(false);
  });

  it('新的一次按下、pointercancel：作废（那一下 click 不会再来了）', () => {
    const { box, inner } = setup();
    swallowNextClick({ within: box });
    down(inner);
    expect(click(inner)).toBe(true);
    swallowNextClick({ within: box });
    inner.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    expect(click(inner)).toBe(true);
  });

  it('在按下的监听里挂上：不被这一次按下自己作废，吞的是这次按下跟着的 click', () => {
    const { box, inner } = setup();
    const onDown = (): void => void swallowNextClick({ within: box });
    document.addEventListener('pointerdown', onDown, true);
    down(inner);
    document.removeEventListener('pointerdown', onDown, true);
    expect(click(inner)).toBe(false);
  });

  it('作废函数：调了就不吞，重复调没事；到点以后 window 上不留监听', () => {
    const { box, inner } = setup();
    const off = swallowNextClick({ within: box });
    off();
    off();
    expect(click(inner)).toBe(true);
    const rm = vi.spyOn(window, 'removeEventListener');
    swallowNextClick({ within: box });
    vi.advanceTimersByTime(TAP_SWALLOW_MS);
    expect(rm.mock.calls.map((c) => c[0]).sort()).toEqual(['click', 'keydown', 'pointercancel', 'pointerdown']);
    rm.mockRestore();
  });
});
