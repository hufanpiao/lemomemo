// 光标偏位试验（台账 Q-8）：键盘弹完后滚动位置和可视区偏移差超过 2px 才对齐，对齐后重设选区；差不多就只记 skip
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUT_KEY, SETTLE_MS, caretSyncOn, readCaretSyncLog, setCaretSyncOn, startCaretSync } from '../caret-sync.ts';

function fakeWin(scrollY: number, offsetTop: number) {
  const vvL: Record<string, (() => void)[]> = {};
  const vv = {
    height: 542,
    offsetTop,
    addEventListener: (t: string, f: () => void) => (vvL[t] ??= []).push(f),
    removeEventListener: vi.fn(),
  };
  const win = {
    visualViewport: vv,
    innerHeight: 542,
    scrollY,
    screen: { width: 440, height: 956 },
    document,
    scrollTo: vi.fn((_x: number, y: number) => {
      win.scrollY = y;
    }),
  };
  return { win: win as unknown as Window & { scrollTo: ReturnType<typeof vi.fn> }, fire: (t: string) => vvL[t]?.forEach((f) => f()) };
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

describe('caret-sync 开关', () => {
  it('开、关、读日志', () => {
    expect(caretSyncOn()).toBe(false);
    setCaretSyncOn(true);
    expect(caretSyncOn()).toBe(true);
    setCaretSyncOn(false);
    expect(caretSyncOn()).toBe(false);
    expect(readCaretSyncLog()).toBe('');
  });
});

describe('startCaretSync', () => {
  it('差 62：键盘停稳后滚到 offsetTop，重设选区，记一行 sync', () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    input.value = 'abc';
    document.body.append(input);
    input.focus();
    input.setSelectionRange(2, 2);
    const spy = vi.spyOn(input, 'setSelectionRange');
    const { win, fire } = fakeWin(353, 291);
    startCaretSync(win, localStorage, () => 0);
    fire('resize');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 291);
    expect(spy).toHaveBeenCalledWith(2, 2);
    expect(localStorage.getItem(OUT_KEY)).toMatch(/sync diff=62 before .*y=353.* after .*y=291/);
  });

  it('差不到 2px 不动，只记 skip；没有输入框聚焦什么都不记', () => {
    vi.useFakeTimers();
    const { win, fire } = fakeWin(291, 290);
    startCaretSync(win, localStorage, () => 0);
    fire('scroll');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(readCaretSyncLog()).not.toMatch(/ (skip|sync) diff=/);
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    fire('scroll');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
    expect(readCaretSyncLog()).toMatch(/skip diff=1/);
  });

  it('连续变化只在最后一次停稳后做一次', () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const { win, fire } = fakeWin(414, 291);
    startCaretSync(win, localStorage, () => 0);
    fire('resize');
    vi.advanceTimersByTime(SETTLE_MS - 50);
    fire('scroll');
    vi.advanceTimersByTime(SETTLE_MS - 50);
    expect(win.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(win.scrollTo).toHaveBeenCalledTimes(1);
  });
});
