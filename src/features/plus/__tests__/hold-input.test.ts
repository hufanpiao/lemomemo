// 按住“＋”的手势（data/hold-input.ts；B3 FA-3、Q3）：350 ms 判定、点一下不进录音、上拖取消、锁定、系统收走触摸、
// 进了录音以后松手补的那一下 click 吞掉、按着时 <html data-plus-hold>、非被动 touchmove 和 contextmenu 拦截、setPointerCapture
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoldInput, HOLD_ATTR, SWALLOW_MS, type HoldPointer, type HoldSink } from '../data/hold-input.ts';
import { HOLD_MS } from '../data/record-logic.ts';

let t = 0;
const now = (): number => t;

function makeSink(over: Partial<HoldSink> = {}) {
  const calls: string[] = [];
  const sink: HoldSink = {
    down: () => void calls.push('down'),
    start: () => {
      calls.push('start');
      return true;
    },
    zoneAt: (_x, y) => (y < 100 ? 'cancel' : y > 900 ? 'lock' : null),
    zone: (z) => void calls.push(`zone:${z ?? '-'}`),
    lock: () => void calls.push('lock'),
    finish: () => void calls.push('finish'),
    discard: () => void calls.push('discard'),
    idle: () => void calls.push('idle'),
    ...over,
  };
  return { sink, calls };
}

let fab: HTMLButtonElement;
const ptr = (x: number, y: number, o: Partial<HoldPointer> = {}): HoldPointer => ({ button: 0, isPrimary: true, pointerId: 7, clientX: x, clientY: y, currentTarget: fab, ...o });
const advance = (ms: number): void => {
  t += ms;
  vi.advanceTimersByTime(ms);
};
const marked = (): boolean => document.documentElement.dataset[HOLD_ATTR] !== undefined;

beforeEach(() => {
  vi.useFakeTimers();
  t = 1000;
  fab = document.createElement('button');
  fab.setPointerCapture = vi.fn();
  document.body.append(fab);
});
afterEach(() => {
  fab.remove();
  vi.useRealTimers();
  delete document.documentElement.dataset[HOLD_ATTR];
});

describe('按住“＋”的手势', () => {
  it('不满 350 ms 松开 = 点一下：不进录音、按下时先开的手机识别关掉、click 照常到', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    expect(fab.setPointerCapture).toHaveBeenCalledWith(7);
    expect(marked(), '按着时 <html> 打标记').toBe(true);
    advance(HOLD_MS - 1);
    h.onEnd(ptr(300, 800));
    expect(calls).toEqual(['down', 'idle']);
    expect(marked()).toBe(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fab.dispatchEvent(click);
    expect(click.defaultPrevented, '点一下的 click 不吞').toBe(false);
  });

  it('计时器早到（到点时 now() 才走了 349 ms）：补上差的那一点再判，照样进录音，不丢这次按住', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    t += HOLD_MS - 1;
    vi.advanceTimersByTime(HOLD_MS);
    expect(calls, '早到的那一下还没满，不开录').toEqual(['down']);
    advance(1);
    expect(calls).toEqual(['down', 'start']);
    h.onEnd(ptr(300, 800));
    expect(calls).toEqual(['down', 'start', 'finish']);
  });

  it('满 350 ms 进录音；松开 = 记下；松手补在“＋”上的 click 吞掉（别处的不吞），过了 SWALLOW_MS 不再吞', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    expect(calls).toEqual(['down', 'start']);
    h.onEnd(ptr(300, 800));
    expect(calls.at(-1)).toBe('finish');
    expect(marked()).toBe(false);
    const other = document.createElement('button');
    document.body.append(other);
    const elsewhere = new MouseEvent('click', { bubbles: true, cancelable: true });
    other.dispatchEvent(elsewhere);
    other.remove();
    expect(elsewhere.defaultPrevented, '落在别处（提示条上的按钮）的照常').toBe(false);
    const swallowed = new MouseEvent('click', { bubbles: true, cancelable: true });
    fab.dispatchEvent(swallowed);
    expect(swallowed.defaultPrevented, '补在“＋”上的这一下不能再打开打字条').toBe(true);
    advance(SWALLOW_MS + 1);
    const later = new MouseEvent('click', { bubbles: true, cancelable: true });
    fab.dispatchEvent(later);
    expect(later.defaultPrevented, '之后的点按照常').toBe(false);
  });

  it('接收方不接手（start 返回 false，例如 exe、正在上传）：当没按住，松开什么都不做，也不吞 click', () => {
    const { sink, calls } = makeSink({ start: () => false });
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    expect(marked()).toBe(false);
    h.onEnd(ptr(300, 800));
    expect(calls, '按下时先开的手机识别照样关掉').toEqual(['down', 'idle']);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fab.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('上拖进取消区：高亮；在区里松开 = 丢弃', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    h.onMove(ptr(300, 50));
    expect(calls.at(-1)).toBe('zone:cancel');
    h.onEnd(ptr(300, 50));
    expect(calls.at(-1)).toBe('discard');
    expect(calls).not.toContain('finish');
  });

  it('拖进取消区又拖出来再松开 = 记下', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    h.onMove(ptr(300, 50));
    h.onMove(ptr(300, 500));
    expect(calls.slice(-2)).toEqual(['zone:cancel', 'zone:-']);
    h.onEnd(ptr(300, 500));
    expect(calls.at(-1)).toBe('finish');
  });

  it('拖进锁定区 = 锁定：之后松手、系统收走触摸都不结束（松手也在录）', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    h.onMove(ptr(100, 950));
    expect(calls.at(-1)).toBe('lock');
    expect(marked(), '锁定以后放开整页').toBe(false);
    h.onEnd(ptr(100, 950));
    h.onCancel(ptr(100, 950));
    expect(calls).not.toContain('finish');
    expect(calls).not.toContain('discard');
    h.reset();
    h.onStart(ptr(300, 800));
    expect(calls.at(-1), 'reset 以后能再按').toBe('down');
  });

  it('录着时系统收走触摸（pointercancel：来电、切走）= 丢弃；没进录音时什么都不做', () => {
    const a = makeSink();
    const h = createHoldInput(() => a.sink, now);
    h.onStart(ptr(300, 800));
    advance(HOLD_MS);
    h.onCancel(ptr(300, 800));
    expect(a.calls.at(-1)).toBe('discard');
    const b = makeSink();
    const h2 = createHoldInput(() => b.sink, now);
    h2.onStart(ptr(300, 800));
    advance(100);
    h2.onCancel(ptr(300, 800));
    expect(b.calls).toEqual(['down', 'idle']);
  });

  it('按下后先挪远（在滑动）：不进录音', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    advance(100);
    h.onMove(ptr(300, 760));
    advance(HOLD_MS);
    expect(calls).not.toContain('start');
  });

  it('右键、第二根手指不算', () => {
    const { sink, calls } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800, { button: 2 }));
    h.onStart(ptr(300, 800, { isPrimary: false }));
    advance(HOLD_MS);
    expect(calls).toEqual([]);
    expect(fab.setPointerCapture).not.toHaveBeenCalled();
  });

  it('“＋”上：contextmenu 一律拦（不出长按菜单）；touchmove 只在按着时拦（非被动）', () => {
    const { sink } = makeSink();
    const h = createHoldInput(() => sink, now);
    h.onStart(ptr(300, 800));
    const menu = new Event('contextmenu', { cancelable: true });
    fab.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    const move = new Event('touchmove', { cancelable: true });
    fab.dispatchEvent(move);
    expect(move.defaultPrevented, '按着时不让页面滚').toBe(true);
    h.onEnd(ptr(300, 800));
    const after = new Event('touchmove', { cancelable: true });
    fab.dispatchEvent(after);
    expect(after.defaultPrevented, '松开以后照常').toBe(false);
  });

  it('还没有接收方（录音那一块没挂上）：按住只当点一下，不报错', () => {
    const h = createHoldInput(() => null, now);
    expect(() => {
      h.onStart(ptr(300, 800));
      advance(HOLD_MS);
      h.onEnd(ptr(300, 800));
    }).not.toThrow();
    expect(marked()).toBe(false);
  });
});
