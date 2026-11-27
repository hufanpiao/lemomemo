// swallowNextClick（审查“吞点按五套”合成一套）：吞一次、只吞元素里的、过时限不吞、新的按下和 pointercancel 作废；
// 键盘的 click（前面有 keydown）不吞（R-420 审查第 12 条）；时限只有一个默认值 TAP_SWALLOW_MS，只靠 setTimeout 过期（假钟）
// guardWindow（一段时间内吞，改善报告第三节第 4 块）：窗口内吞几种事件、只吞范围里的、认键盘只看 keydown、到时或放开摘干净、自定吞法
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardWindow as openWindow, swallowNextClick } from '../swallow-click.ts';
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

describe('guardWindow', () => {
  /** 每条用例挂的窗口用完放开（ms 为 null 的、假钟没走到的不会自己摘，留着会吞下一条用例的事件） */
  const opened: (() => void)[] = [];
  const guardWindow = (...a: Parameters<typeof openWindow>): (() => void) => {
    const free = openWindow(...a);
    opened.push(free);
    return free;
  };
  afterEach(() => {
    for (const f of opened.splice(0)) f();
    vi.restoreAllMocks();
  });
  const ev = (el: Element, type: string, detail = 1): boolean =>
    el.dispatchEvent(type === 'click' ? new MouseEvent('click', { bubbles: true, cancelable: true, detail }) : new Event(type, { bubbles: true, cancelable: true }));

  it('窗口内吞给的几种事件、只吞范围里的；过了时限不吞', () => {
    const { box, inner, other } = setup();
    guardWindow({ ms: 100, types: ['pointerdown', 'click'], within: box });
    expect(ev(inner, 'pointerdown')).toBe(false);
    expect(ev(inner, 'pointerup')).toBe(true);
    expect(ev(inner, 'click')).toBe(false);
    expect(ev(inner, 'click'), '窗口内每一下都吞，不是只吞一下').toBe(false);
    expect(ev(other, 'click')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(ev(inner, 'click')).toBe(true);
  });

  it('within 给函数：从事件找范围，找不到不吞；吞法 eat 拿到找到的节点', () => {
    const { box, inner, other } = setup();
    const eat = vi.fn((e: Event) => e.preventDefault());
    guardWindow({ ms: 100, types: ['click'], within: (e) => (e.target instanceof Element ? e.target.closest('div') : null), eat });
    expect(ev(inner, 'click')).toBe(false);
    expect(eat).toHaveBeenCalledWith(expect.any(MouseEvent), box);
    expect(ev(other, 'click')).toBe(true);
    expect(eat).toHaveBeenCalledTimes(1);
  });

  it("keyboard: 'keydown'：先有 keydown 的那一下 click 放过；detail 0 但没有 keydown 的照样吞；新的按下把标记作废", () => {
    const { inner } = setup();
    guardWindow({ ms: null, types: ['pointerdown', 'click'], keyboard: 'keydown' });
    expect(ev(inner, 'click', 0), '页面里派发的 detail 0（e2e 模拟手指）').toBe(false);
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ev(inner, 'click', 0)).toBe(true);
    expect(ev(inner, 'click', 0), '标记只放过紧跟着的一下').toBe(false);
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ev(inner, 'pointerdown');
    expect(ev(inner, 'click'), '按过键盘以后又按下了手指：这一下是手指的').toBe(false);
  });

  it("keyboard: 'keydown' 而 types 里没有 pointerdown：按过一次键以后再用手指点，那一下照样吞；pointerdown 本身不吞", () => {
    const { inner } = setup();
    guardWindow({ ms: null, types: ['click'], keyboard: 'keydown' });
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ev(inner, 'pointerdown'), 'pointerdown 只用来作废键盘标记').toBe(true);
    expect(ev(inner, 'click'), '按过键盘以后又按下了手指：这一下是手指的').toBe(false);
  });

  it('不给 keyboard：键盘的 click 也吞', () => {
    const { inner } = setup();
    guardWindow({ ms: 100, types: ['click'] });
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(ev(inner, 'click', 0)).toBe(false);
  });

  it('ms 为 null 一直吞到放开；放开、到时都摘干净，重复放开没事；挂在 on 上', () => {
    const { box, inner } = setup();
    const add = vi.spyOn(box, 'addEventListener');
    const rm = vi.spyOn(box, 'removeEventListener');
    const free = guardWindow({ ms: null, types: ['pointerdown', 'pointerup', 'click'], on: box, keyboard: 'keydown' });
    vi.advanceTimersByTime(60_000);
    expect(ev(inner, 'pointerup')).toBe(false);
    free();
    free();
    expect(ev(inner, 'pointerup')).toBe(true);
    expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(rm.mock.calls.map((c) => c[0]).sort());
    expect(rm.mock.calls.map((c) => c[0]).sort()).toEqual(['click', 'keydown', 'pointerdown', 'pointerup']);
  });

  it('计时器被拖晚：过了时限才来的事件不吞，当场摘掉', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { inner } = setup();
    const rm = vi.spyOn(document, 'removeEventListener');
    guardWindow({ ms: 100, types: ['click'] });
    // 只推时钟、不让计时器跑：模拟主线程忙、setTimeout 晚到
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 150);
    expect(ev(inner, 'click')).toBe(true);
    expect(rm).toHaveBeenCalledWith('click', expect.any(Function), true);
  });
});
