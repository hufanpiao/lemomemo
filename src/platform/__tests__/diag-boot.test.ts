// 非正式版的诊断启动件（platform/diag-boot.ts）：运行日志一直开；冷启动时间线、启动画面颜色诊断按诊断页开关；
// main.tsx 只在非正式版分支里动态 import 它这一处，入口里不再读诊断开关（Gap fix 正式版也做，不经这里）。
// 启动画面多留 8 秒的标记由它打：main.tsx 的 5 秒兜底和 #root 画出东西这两处走 leaveSplash、先等它（diagReady），标记早于这两处的收起；进退出屏、库被挡住时直接收，不等诊断
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_MARKERS } from '../../../build/check_no_probe.mjs';
import { startDiagBoot } from '../diag-boot.ts';
import { readGapFixLog } from '../vh-gapfix.ts';
import { OUT_KEY as RUN_LOG_KEY } from '../run-log.ts';
import { ARM_KEY as SPLASH_ARM_KEY } from '../splash-probe-arm.ts';
import { resetRootPaintForTest, watchRoot, whenContent } from '../root-paint.ts';
import { hideSplash, hideSplashAfter, SPLASH_HOLD_ATTR, SPLASH_HOLD_MS, SPLASH_ID, SPLASH_MAX_MS } from '../splash.ts';
import { ARM_KEY as TL_ARM_KEY, OUT_KEY as TL_OUT_KEY } from '../vh-timeline.ts';

vi.mock('../splash-probe.ts', () => ({ startSplashProbe: vi.fn() }));

/** 只收不跑的“帧”：只看启动那一刻做了什么 */
const frame = (_cb: () => void): void => undefined;

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset[SPLASH_HOLD_ATTR];
});

describe('startDiagBoot', () => {
  it('运行日志一直开；时间线开关没开不记、开着记一次并关掉开关；不跑 Gap fix', () => {
    startDiagBoot(frame);
    expect(localStorage.getItem(RUN_LOG_KEY) ?? '').not.toBe('');
    expect(localStorage.getItem(TL_OUT_KEY)).toBeNull();
    localStorage.setItem(TL_ARM_KEY, '1');
    startDiagBoot(frame);
    expect(localStorage.getItem(TL_ARM_KEY)).toBeNull();
    expect(localStorage.getItem(TL_OUT_KEY)).not.toBeNull();
    expect(readGapFixLog()).toBe('');
  });

  it('启动画面颜色诊断开着：下载涂色分包、到了才打 data-splash-hold，返回的 Promise 这时才完成；没开不打', async () => {
    await startDiagBoot(frame);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined();
    localStorage.setItem(SPLASH_ARM_KEY, '1');
    const done = startDiagBoot(frame);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined();
    await done;
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBe('1');
    const probe = await import('../splash-probe.ts');
    expect(probe.startSplashProbe).toHaveBeenCalledOnce();
  });

  it('开始涂色出错（和涂色分包加载失败同一个出口）：不留标记、清掉开关，Promise 照常完成', async () => {
    const probe = await import('../splash-probe.ts');
    vi.mocked(probe.startSplashProbe).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    localStorage.setItem(SPLASH_ARM_KEY, '1');
    await expect(startDiagBoot(frame)).resolves.toBeUndefined();
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined();
    expect(localStorage.getItem(SPLASH_ARM_KEY)).toBeNull();
  });
});

/** main.tsx 里这两行原样（下面“接线”核对 main.tsx 里确实是这样写的）；时序用例照它接 */
const DIAG_READY =
  "const diagReady: Promise<void> | null =\n  import.meta.env.MODE !== 'production' ? import('../platform/diag-boot.ts').then((m) => m.startDiagBoot(nextFrame)).catch(() => undefined) : null;";
const LEAVE = 'const leaveSplash = (): void => void (diagReady ? diagReady.then(hideSplash) : hideSplash());';

describe('启动画面颜色诊断开着：#root 先于 diag-boot 画出内容，启动画面仍然多留 8 秒', () => {
  const now = (cb: () => void): (() => void) => {
    cb();
    return () => undefined;
  };
  /** 启动画面还盖着：还在页面里、没开始淡出 */
  const covering = (): boolean => document.getElementById(SPLASH_ID)?.classList.contains('is-leaving') === false;

  /** 照 main.tsx 接：diag-boot 分包（chunk 由用例决定什么时候到）→ diagReady；5 秒兜底和 #root 画出东西都走 leaveSplash */
  function boot(chunk: Promise<unknown>) {
    const diagReady: Promise<void> | null = chunk.then(() => startDiagBoot(frame)).catch(() => undefined);
    const leaveSplash = (): void => void (diagReady ? diagReady.then(hideSplash) : hideSplash());
    hideSplashAfter(leaveSplash);
    const root = document.createElement('div');
    document.body.appendChild(root);
    watchRoot(root, now);
    whenContent(() => void now(leaveSplash));
    return root;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const el = document.createElement('div');
    el.id = SPLASH_ID;
    document.body.appendChild(el);
    localStorage.setItem(SPLASH_ARM_KEY, '1');
  });
  afterEach(() => {
    resetRootPaintForTest();
    vi.useRealTimers();
  });

  it('#root 先画出东西、5 秒兜底也到了，diag-boot 才回来：不先淡出；标记打上以后从那一刻起再多留 8 秒', async () => {
    let arrive = (): void => undefined;
    const root = boot(new Promise<void>((r) => (arrive = r)));
    root.appendChild(document.createElement('main'));
    await vi.advanceTimersByTimeAsync(SPLASH_MAX_MS + 1000);
    expect(covering()).toBe(true);
    arrive();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBe('1');
    await vi.advanceTimersByTimeAsync(SPLASH_HOLD_MS - 1);
    expect(covering()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(covering()).toBe(false);
  });

  it('diag-boot 分包加载失败：当它好了，马上照常收起（不一直盖着）', async () => {
    let fail = (): void => undefined;
    const root = boot(new Promise<void>((_, j) => (fail = () => j(new TypeError('Failed to fetch dynamically imported module')))));
    root.appendChild(document.createElement('main'));
    expect(covering()).toBe(true);
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined();
    expect(covering()).toBe(false);
  });
});

describe('接线', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../app/main.tsx'), 'utf8');
  const code = main.replace(/^\s*\/\/.*$/gm, '');
  it('main.tsx 只在非正式版分支里动态 import diag-boot 这一处；入口里不读诊断开关、不静态引诊断模块', () => {
    expect(main).toContain(DIAG_READY);
    expect(main.match(/import\.meta\.env\.MODE !== 'production'/g)?.length).toBe(1);
    expect(main.match(/import\('\.\.\/platform\/diag-boot\.ts'\)/g)?.length).toBe(1);
    for (const key of [TL_ARM_KEY, SPLASH_ARM_KEY, 'lemo-run-log']) expect(main).not.toContain(key);
    for (const mod of ['run-log', 'vh-timeline', 'splash-probe', 'diag-boot']) expect(main).not.toMatch(new RegExp(`^import [^;]*${mod}`, 'm'));
    expect(main).not.toMatch(/SPLASH_HOLD_ATTR|cancelSplashHold/);
  });

  it('5 秒兜底和 #root 画出东西这两处走 leaveSplash、先等 diagReady（进退出屏的两处直接收，不等诊断）；diagReady、leaveSplash 写在 5 秒兜底之前', () => {
    expect(main).toContain(LEAVE);
    expect(code).toMatch(/^hideSplashAfter\(leaveSplash\);$/m);
    expect(code).toContain('whenContent(() => void nextFrame(leaveSplash));');
    expect(code.indexOf(DIAG_READY)).toBeLessThan(code.indexOf(LEAVE));
    expect(code.indexOf(LEAVE)).toBeLessThan(code.indexOf('hideSplashAfter('));
    // 除了 leaveSplash 自己，只有 start() 里冷启动就进退出屏的两处（还没挂 #root）直接收、不等诊断；库被挡住的 SplashRelease 在 root.tsx，也直接收
    expect(code.match(/hideSplash\(\)/g)?.length).toBe(3);
  });

  it('分包名登记进 PROBE_MARKERS（正式包不能带）', () => {
    expect(PROBE_MARKERS).toContain('diag-boot');
  });
});
