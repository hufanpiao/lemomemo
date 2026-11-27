// 时钟偏差（架构 4.3；TC-B1-31：5 个 Date 头其中一个离群取中位数；偏差 1.5 秒当 0）
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_WRONG_MS, createClock, isSbUrl, offsetOf } from '../clock.ts';

const T0 = Date.UTC(2026, 9, 29, 3, 0, 0);
const http = (ms: number): string => new Date(ms).toUTCString();   // Date 头的格式：Thu, 29 Oct 2026 03:00:00 GMT

describe('TC-B1-31 时钟偏差', () => {
  it('5 个 Date 头、其中一个离群：取中位数', () => {
    const c = createClock(() => T0);
    for (const d of [30_000, 31_000, 29_000, 3_600_000, 30_000]) c.record(http(T0 + d), T0);
    expect(c.offset()).toBe(30_000);
    expect(c.now()).toBe(T0 + 30_000);
  });

  it('偏差 1.5 秒：小于 2 秒当 0', () => {
    expect(offsetOf([1_500, 1_500, 1_500])).toBe(0);
    expect(offsetOf([-1_999])).toBe(0);
    expect(offsetOf([2_000])).toBe(2_000);
    const c = createClock(() => T0);
    for (let i = 0; i < 5; i++) c.record(new Date(T0 + 1_500).toUTCString(), T0 - 0);
    // Date 头只精确到秒：+1.5 秒写出来是 +1 秒
    expect(c.offset()).toBe(0);
    expect(c.now()).toBe(T0);
  });

  it('只留最近 5 次；偶数个取中间两个的平均', () => {
    expect(offsetOf([10_000, 20_000])).toBe(15_000);
    const c = createClock(() => T0);
    for (const d of [-60_000, -60_000, -60_000, 10_000, 10_000, 10_000, 10_000, 10_000]) c.record(http(T0 + d), T0);
    expect(c.offset()).toBe(10_000);
  });

  it('解析不了的 Date、没有 Date、不是 /sb/ 的响应：忽略', () => {
    const c = createClock(() => T0);
    c.record('不是时间', T0);
    c.record(null, T0);
    c.observeResponse('https://example.com/x', http(T0 + 600_000));
    expect(c.offset()).toBe(0);
    c.observeResponse('/sb/rest/v1/todos?select=*', http(T0 + 600_000));
    expect(c.offset()).toBe(600_000);
    expect(isSbUrl('https://lemomemo.app/sb/auth/v1/token')).toBe(true);
    expect(isSbUrl('https://lemomemo.app/files/v1/x')).toBe(false);
  });

  it('偏差超过 5 分钟：手机时间不准；offset 变了才通知', () => {
    const c = createClock(() => T0);
    const fn = vi.fn();
    c.subscribe(fn);
    c.record(http(T0 + CLOCK_WRONG_MS), T0);
    expect(c.isClockWrong()).toBe(false);   // 正好 5 分钟不算
    c.record(http(T0 + CLOCK_WRONG_MS + 60_000), T0);
    c.record(http(T0 + CLOCK_WRONG_MS + 60_000), T0);
    expect(c.isClockWrong()).toBe(true);
    const calls = fn.mock.calls.length;
    c.record(http(T0 + CLOCK_WRONG_MS + 60_000), T0);   // 中位数没变
    expect(fn.mock.calls.length).toBe(calls);
  });
});
