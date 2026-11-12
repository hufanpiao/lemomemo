// 键盘真收了以后再做一次冷启动高度校正（Q-4，vh-gapfix.ts 的 startGapFix 订阅 viewport.ts 的“键盘真收了”）：冷启动 895 → 修好 956 → 键盘 542 → 收起回 895 时再做一次、记 kb 日志；
// 条件不满足不做、连续 focusout 不叠跑、诊断页关掉不做、键盘还在不做、用户在滚不抢、停止、日志上限、网页版不盯键盘。
// 做着时来的不接、innerHeight 一变就撤、输入期间不动的几条在 vh-gapfix-editing.test.ts；走默认接法（共享 watcher）的在 vh-gapfix-kb-device.test.ts
import { describe, expect, it, vi } from 'vitest';
import { KB_SETTLE_MS } from '../viewport.ts';
import { GIVE_UP_MS, SCROLL_AT_MS, setGapFixOn } from '../vh-gapfix.ts';
import { PAD_ID } from '../vh-gapfix-gate.ts';
import { coldThenKeyboard, frames, input, mockScroll, mountBar, pad, readGapFixLog, resize, setInner, settle, startKb, st, vvResize } from './gapfix-fixture.ts';

describe('键盘真收了以后再做一次（Q-4：冷启动 895 → 修好 956 → 键盘 542 → 收起回 895）', () => {
  const kbPads = (): number => readGapFixLog().match(/kb pad /g)?.length ?? 0;

  it('静了 KB_SETTLE_MS 才做同一套：放垫块（日志带 kb）、innerHeight 回 956 就撤', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    vi.advanceTimersByTime(KB_SETTLE_MS - 1);
    expect(pad()).toBeNull();
    settle();
    expect(pad()).not.toBeNull();
    expect(pad()?.style.height).toBe('calc(100dvh + 62px)');
    setInner(956);
    f.flush();
    expect(pad()).toBeNull();
    const log = readGapFixLog();
    expect(log).toMatch(/kb pad gap=61 top=61/);
    expect(log).toMatch(/kb changed 895->956 by-pad pad-removed inner=956/);
    expect(f.size).toBe(0);
  });

  it('键盘那次也会滚 1px 再滚回、到点撤；之后再来 resize 不再做（退膛，等下次键盘弹起）', () => {
    const { by, to } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    st.clock += SCROLL_AT_MS;
    f.flush();
    expect(by).toHaveBeenCalledWith(0, 1);
    f.flush();
    expect(to).toHaveBeenCalledWith(0, 0);
    st.clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/kb scrollBy1[\s\S]*kb no-change pad-removed/);
    vvResize(895);
    settle();
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('连续多次 focusout / resize 不叠跑：只放一块垫块、只记一次 kb pad；做着的时候再来也不再放', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    for (let k = 0; k < 5; k++) {
      st.clock += 50;
      vi.advanceTimersByTime(50);
      document.dispatchEvent(new FocusEvent('focusout'));
      vvResize(895);
      f.flush();
    }
    expect(pad()).toBeNull();
    settle();
    expect(document.querySelectorAll('#' + PAD_ID)).toHaveLength(1);
    document.dispatchEvent(new FocusEvent('focusout'));
    vvResize(895);
    settle();
    expect(document.querySelectorAll('#' + PAD_ID)).toHaveLength(1);
    expect(kbPads()).toBe(1);
  });

  it('键盘还在（焦点挪到另一个输入框）时不做，真收起了才做', () => {
    mockScroll();
    const f = frames();
    mountBar();
    startKb(f.frame);
    setInner(956);
    f.flush();
    const a = input();
    a.focus();
    resize(542);
    const b = input();
    b.focus();
    settle();
    expect(pad()).toBeNull();
    // innerHeight 回来了但焦点还在输入框：也不做
    resize(895);
    settle();
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(0);
    b.blur();
    settle();
    expect(pad()).not.toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('条件不满足（收起后回到 956，正常）：只记 kb skip，不放垫块、不滚', () => {
    const { by } = mockScroll();
    const f = frames();
    mountBar();
    startKb(f.frame);
    setInner(956);
    f.flush();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(956);
    settle();
    expect(pad()).toBeNull();
    expect(by).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/kb skip no-gap\(0\) top=61/);
  });

  it('诊断页中途关掉 Gap fix：收起后不做，记 kb skip off', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    setGapFixOn(false);
    settle();
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/kb skip off/);
  });

  it('代码审 M1：用户正在滚（手指按着、页面被滚过），键盘那次不补 1px 滚动，只靠垫块，到点照样撤', () => {
    const { by, to } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    expect(pad()).not.toBeNull();
    document.dispatchEvent(new Event('touchstart'));
    st.sy = 120;
    st.clock += SCROLL_AT_MS;
    f.flush();
    expect(by).not.toHaveBeenCalled();
    st.clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(to).not.toHaveBeenCalled();
    expect(st.sy).toBe(120);
    expect(readGapFixLog()).toMatch(/kb scroll-skipped user-scrolling y=120/);
  });

  it('停止函数：之后键盘起落都不理', () => {
    const f = frames();
    mountBar();
    const stop = startKb(f.frame);
    setInner(956);
    f.flush();
    stop();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    settle();
    expect(readGapFixLog()).not.toMatch(/kb/);
    expect(pad()).toBeNull();
  });

  it('网页版（不是主屏幕版）不盯键盘', () => {
    const kbClosed = vi.fn(() => () => undefined);
    mountBar();
    startKb(frames().frame, { standalone: false, kbClosed });
    expect(kbClosed).not.toHaveBeenCalled();
  });
});
