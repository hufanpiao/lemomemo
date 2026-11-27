// 打字条打开时按上次键盘高度就位（台账 #484）：有记录就先写 --kb-hint；键盘出来记下高度并撤掉；等不到键盘就撤掉并忘掉；收尾撤掉
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdForKeyboard, KB_HINT_VAR } from '../kb-hint.ts';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../run-log-api.ts', () => ({ rlog: (l: string) => logs.push(l) }));
// 键盘高度由 viewport.ts 给（watchKeyboard 回调里读 keyboardOverPx，就是写到 --kb 的值）：替身记下回调，kb() 照 viewport.ts 的顺序先写 --kb 再叫回调
const kbFx = vi.hoisted(() => ({ fns: new Set<(open: boolean, h: number) => void>(), over: 0 }));
vi.mock('../viewport.ts', () => ({
  watchKeyboard: (fn: (open: boolean, h: number) => void) => {
    kbFx.fns.add(fn);
    return () => kbFx.fns.delete(fn);
  },
  keyboardOverPx: () => kbFx.over,
}));

const root = document.documentElement;
const hint = (): string => root.style.getPropertyValue(KB_HINT_VAR);
const kb = (px: number): void => {
  kbFx.over = px;
  root.style.setProperty('--kb', `${px}px`);
  for (const fn of [...kbFx.fns]) fn(true, px);
};

beforeEach(() => {
  logs.length = 0;
  kbFx.over = 0;
  localStorage.clear();
  root.removeAttribute('style');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('kb-hint', () => {
  it('没有记录：不先抬；键盘出来以后记下高度', () => {
    const stop = holdForKeyboard();
    expect(hint()).toBe('');
    kb(416);
    expect(localStorage.getItem('lemo.kb-last')).toBe('416');
    stop();
  });

  it('有记录：打开就写 --kb-hint；键盘出来（--kb 写上）当场撤掉，高度变了就改记', () => {
    localStorage.setItem('lemo.kb-last', '416');
    const stop = holdForKeyboard();
    expect(hint()).toBe('416px');
    kb(414);
    expect(hint()).toBe('');
    expect(localStorage.getItem('lemo.kb-last')).toBe('414');
    expect(logs).toEqual(['kbhint on px=416', 'kbhint off why=kb']);
    stop();
  });

  it('等不到键盘：到点撤掉，并忘掉记录（下次不再先抬）', () => {
    localStorage.setItem('lemo.kb-last', '416');
    const stop = holdForKeyboard();
    vi.advanceTimersByTime(900);
    expect(hint()).toBe('');
    expect(localStorage.getItem('lemo.kb-last')).toBeNull();
    expect(logs.at(-1)).toBe('kbhint off why=timeout');
    stop();
  });

  it('收尾：还抬着就撤掉；记录离谱（太小、太大、不是数）当没有', () => {
    localStorage.setItem('lemo.kb-last', '416');
    holdForKeyboard()();
    expect(hint()).toBe('');
    expect(logs.at(-1)).toBe('kbhint off why=close');
    for (const bad of ['40', '2000', 'x']) {
      localStorage.setItem('lemo.kb-last', bad);
      const stop = holdForKeyboard();
      expect(hint()).toBe('');
      stop();
    }
  });

  it('收尾以后不再听键盘；键盘高度不到 120（挤矮、没弹）不记也不撤', () => {
    localStorage.setItem('lemo.kb-last', '416');
    const stop = holdForKeyboard();
    kb(80);
    expect(hint()).toBe('416px');
    expect(localStorage.getItem('lemo.kb-last')).toBe('416');
    stop();
    expect(kbFx.fns.size).toBe(0);
  });

  it('键盘已经开着（--kb 在）：不再写 --kb-hint', () => {
    localStorage.setItem('lemo.kb-last', '416');
    root.style.setProperty('--kb', '416px');
    const stop = holdForKeyboard();
    expect(hint()).toBe('');
    stop();
  });
});
