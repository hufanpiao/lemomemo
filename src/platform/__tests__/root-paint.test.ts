// 首屏画完的标志（src/platform/root-paint.ts）：没 arm 过当场执行；arm 以后 markAppPainted、长兜底、render 后的时限三条路谁先到算谁，只算一次。
// 什么时候调 markAppPainted（页面出来再过一帧）在 src/app/__tests__/first-paint.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterAppPainted, appPainted, APP_PAINT_BACKSTOP_MS, armAppPaint, isAppPainted, markAppPainted, resetRootPaintForTest, startAppPaintLimit,
} from '../root-paint.ts';

beforeEach(() => resetRootPaintForTest());
afterEach(() => {
  vi.useRealTimers();
  resetRootPaintForTest();
});

describe('首屏画完', () => {
  it('没 arm 过：afterAppPainted 当场执行、isAppPainted 为真', () => {
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isAppPainted()).toBe(true);
  });

  it('arm 以后 markAppPainted 才执行；之前排着的按顺序执行，之后来的当场执行；重复 mark 不再执行', async () => {
    armAppPaint();
    const seen: string[] = [];
    afterAppPainted(() => seen.push('a'));
    const p = appPainted().then(() => seen.push('p'));
    expect(isAppPainted()).toBe(false);
    markAppPainted();
    await p;
    expect(seen).toEqual(['a', 'p']);
    afterAppPainted(() => seen.push('b'));
    markAppPainted();
    expect(seen).toEqual(['a', 'p', 'b']);
  });

  it('一直没有功能页（整屏提示）：render 后的时限到了也算画完；之后再 mark 也不重复执行', () => {
    vi.useFakeTimers();
    armAppPaint();
    const fn = vi.fn();
    afterAppPainted(fn);
    startAppPaintLimit(6000);
    vi.advanceTimersByTime(5999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    markAppPainted();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('时限从 render 起算（审查 L1）：arm 以后过了好几秒才 render 不会提前用完', () => {
    vi.useFakeTimers();
    // 长兜底给大，确认到点的是时限
    armAppPaint(600_000);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    startAppPaintLimit(6000);
    vi.advanceTimersByTime(5999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('入口在 render 之前就走了（换账号）：长兜底 APP_PAINT_BACKSTOP_MS 到了也放行', () => {
    vi.useFakeTimers();
    armAppPaint();
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(APP_PAINT_BACKSTOP_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('startAppPaintLimit：没 arm 过、已画完时不计时；重复调用只计第一次；画完以后定时器全清', () => {
    vi.useFakeTimers();
    startAppPaintLimit(1000);
    expect(vi.getTimerCount()).toBe(0);
    armAppPaint();
    startAppPaintLimit(1000);
    startAppPaintLimit(50_000);
    expect(vi.getTimerCount()).toBe(2);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    startAppPaintLimit(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('只 arm 一次：第二次 armAppPaint 不起作用；一个回调出错不挡别的', () => {
    vi.useFakeTimers();
    armAppPaint(1000);
    armAppPaint(50_000);
    expect(vi.getTimerCount()).toBe(1);
    const fn = vi.fn();
    afterAppPainted(() => {
      throw new Error('boom');
    });
    afterAppPainted(fn);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('取消函数：清掉兜底和时限（测试用）', () => {
    vi.useFakeTimers();
    const stop = armAppPaint(4000);
    startAppPaintLimit(4000);
    stop();
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
