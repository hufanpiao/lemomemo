// app/after-paint.ts 的 startAfterPaint（B2 FA-6 ③ 审查 M1、L6）：首屏画完以后那批启动件下载失败、一直挂着时，
// 退避重试、恢复网络和切回前台立刻再试、每次下载前后都过换账号闸；main.tsx 的 onLoaded 才起同步（接线见 first-paint-wiring.test.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFTER_PAINT_NOTICE_AT, AFTER_PAINT_RETRY_MS, AFTER_PAINT_TIMEOUT_MS, startAfterPaint, type StartAfterPaintDeps } from '../after-paint.ts';

type Mod = { wireSync: () => void };

function fakeLife() {
  const online = new Set<() => void>();
  const vis = new Set<(v: boolean) => void>();
  return {
    life: {
      onOnline: (fn: () => void) => (online.add(fn), () => void online.delete(fn)),
      onVisibility: (fn: (v: boolean) => void) => (vis.add(fn), () => void vis.delete(fn)),
    },
    goOnline: () => [...online].forEach((f) => f()),
    visible: (v: boolean) => [...vis].forEach((f) => f(v)),
    listeners: () => online.size + vis.size,
  };
}

/** 每次 load 给一个可以手动 resolve / reject 的 promise */
function loads() {
  const calls: { ok: (m: Mod) => void; bad: (e: unknown) => void }[] = [];
  const load = vi.fn(() => new Promise<Mod>((ok, bad) => calls.push({ ok, bad })));
  return { load, calls };
}

function setup(over: Partial<StartAfterPaintDeps<Mod>> = {}) {
  const l = fakeLife();
  const { load, calls } = loads();
  let owner = true;
  const wireSync = vi.fn();
  const d = {
    load,
    stillOwner: vi.fn(() => owner),
    onLoaded: vi.fn((m: Mod) => m.wireSync()),
    onFailed: vi.fn(),
    onAbandoned: vi.fn(),
    life: l.life,
    ...over,
  };
  const stop = startAfterPaint(d);
  return { ...l, d, load, calls, wireSync, stop, switchAccount: () => (owner = false) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const FIRST_RETRY = AFTER_PAINT_RETRY_MS[0] ?? 0;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startAfterPaint：下载失败、挂着时的重试（③ 审查 M1）', () => {
  it('第一次失败、第二次成功：按退避 2 秒后再试，成功才 onLoaded（起同步）一次；成功以后不再听 online、前台', async () => {
    const s = setup();
    expect(s.load).toHaveBeenCalledTimes(1);
    s.calls[0]?.bad(new Error('net'));
    await flush();
    expect(s.d.onFailed).toHaveBeenCalledWith(1, 'error');
    expect(s.d.onLoaded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY - 1);
    expect(s.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.load).toHaveBeenCalledTimes(2);
    s.calls[1]?.ok({ wireSync: s.wireSync });
    await flush();
    expect(s.d.onLoaded).toHaveBeenCalledTimes(1);
    expect(s.wireSync).toHaveBeenCalledTimes(1);
    expect(s.listeners()).toBe(0);
    s.goOnline();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.load).toHaveBeenCalledTimes(2);
    expect(s.d.onAbandoned).not.toHaveBeenCalled();
  });

  it('恢复网络立刻再试（不等退避）；正在下载时再来 online 不重复发起', async () => {
    const s = setup();
    s.calls[0]?.bad(new Error('offline'));
    await flush();
    s.goOnline();
    expect(s.load).toHaveBeenCalledTimes(2);
    s.goOnline();
    expect(s.load).toHaveBeenCalledTimes(2);
    s.calls[1]?.ok({ wireSync: s.wireSync });
    await flush();
    expect(s.wireSync).toHaveBeenCalledTimes(1);
    // 原来排着的退避计时器已经取消，不会再下载一次
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.load).toHaveBeenCalledTimes(2);
  });

  it('切回前台立刻再试；切到后台不算；还没失败过时的 online、前台不另外发起', async () => {
    const s = setup();
    s.goOnline();
    s.visible(true);
    expect(s.load).toHaveBeenCalledTimes(1);
    s.calls[0]?.bad(new Error('x'));
    await flush();
    s.visible(false);
    expect(s.load).toHaveBeenCalledTimes(1);
    s.visible(true);
    expect(s.load).toHaveBeenCalledTimes(2);
  });

  it('重试前换了账号：不再下载、不起同步，调 onAbandoned（设 null 推送认领上下文），之后也不再重试', async () => {
    const s = setup();
    s.calls[0]?.bad(new Error('x'));
    await flush();
    s.switchAccount();
    s.goOnline();
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.d.onAbandoned).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.d.onLoaded).not.toHaveBeenCalled();
    expect(s.listeners()).toBe(0);
  });

  it('下载期间换了账号：回来时过闸不通过，不起同步，调 onAbandoned', async () => {
    const s = setup();
    s.switchAccount();
    s.calls[0]?.ok({ wireSync: s.wireSync });
    await flush();
    expect(s.d.onLoaded).not.toHaveBeenCalled();
    expect(s.wireSync).not.toHaveBeenCalled();
    expect(s.d.onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('开始时闸就不过：一次都不下载', () => {
    const l = fakeLife();
    const load = vi.fn(async () => ({ wireSync: vi.fn() }));
    const onAbandoned = vi.fn();
    startAfterPaint({ load, stillOwner: () => false, onLoaded: vi.fn(), onFailed: vi.fn(), onAbandoned, life: l.life });
    expect(load).not.toHaveBeenCalled();
    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('一直挂着：超过 15 秒按 timeout 失败、进入重试；先挂着的那次后来回来了照样用，只 onLoaded 一次', async () => {
    expect(AFTER_PAINT_TIMEOUT_MS).toBe(15_000);
    const s = setup();
    await vi.advanceTimersByTimeAsync(AFTER_PAINT_TIMEOUT_MS - 1);
    expect(s.d.onFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.d.onFailed).toHaveBeenCalledWith(1, 'timeout');
    await vi.advanceTimersByTimeAsync(FIRST_RETRY);
    expect(s.load).toHaveBeenCalledTimes(2);
    s.calls[0]?.ok({ wireSync: s.wireSync });
    await flush();
    expect(s.d.onLoaded).toHaveBeenCalledTimes(1);
    s.calls[1]?.ok({ wireSync: s.wireSync });
    await flush();
    expect(s.d.onLoaded).toHaveBeenCalledTimes(1);
    expect(s.wireSync).toHaveBeenCalledTimes(1);
  });

  it('退避逐次加长、最长 5 分钟；连续失败计数交给 onFailed（第 3 次 main.tsx 出横幅）；load 同步抛错也按失败算', async () => {
    expect(AFTER_PAINT_NOTICE_AT).toBe(3);
    expect(AFTER_PAINT_RETRY_MS.slice(0, 3)).toEqual([2_000, 4_000, 8_000]);
    expect(Math.max(...AFTER_PAINT_RETRY_MS)).toBe(300_000);
    let n = 0;
    const l = fakeLife();
    const onFailed = vi.fn();
    const load = vi.fn((): Promise<Mod> => {
      n += 1;
      if (n === 1) throw new Error('sync_throw');
      return Promise.reject(new Error('net'));
    });
    startAfterPaint({ load, stillOwner: () => true, onLoaded: vi.fn(), onFailed, onAbandoned: vi.fn(), life: l.life });
    await flush();
    expect(onFailed).toHaveBeenLastCalledWith(1, 'error');
    const waits: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const before = load.mock.calls.length;
      let t = 0;
      while (load.mock.calls.length === before) {
        await vi.advanceTimersByTimeAsync(1000);
        t += 1000;
      }
      waits.push(t);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000]);
    expect(onFailed.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
