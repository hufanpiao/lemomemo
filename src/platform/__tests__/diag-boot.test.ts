// 非正式版的诊断启动件（platform/diag-boot.ts）：运行日志一直开；冷启动时间线、启动画面颜色诊断按诊断页开关；
// main.tsx 只在非正式版分支里动态 import 它这一处，入口里不再读诊断开关（Gap fix 正式版也做，不经这里）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_MARKERS } from '../../../build/check_no_probe.mjs';
import { startDiagBoot } from '../diag-boot.ts';
import { readGapFixLog } from '../vh-gapfix.ts';
import { OUT_KEY as RUN_LOG_KEY } from '../run-log.ts';
import { ARM_KEY as SPLASH_ARM_KEY } from '../splash-probe-arm.ts';
import { SPLASH_HOLD_ATTR } from '../splash.ts';
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

  it('启动画面颜色诊断开着：打上 data-splash-hold、下载涂色分包；没开不打', async () => {
    startDiagBoot(frame);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined();
    localStorage.setItem(SPLASH_ARM_KEY, '1');
    startDiagBoot(frame);
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBe('1');
    const probe = await import('../splash-probe.ts');
    await vi.waitFor(() => expect(probe.startSplashProbe).toHaveBeenCalledOnce());
  });
});

describe('接线', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../app/main.tsx'), 'utf8');
  it('main.tsx 只在非正式版分支里动态 import diag-boot 这一处；入口里不读诊断开关、不静态引诊断模块', () => {
    expect(main).toMatch(
      /if \(import\.meta\.env\.MODE !== 'production'\) \{\n {2}void import\('\.\.\/platform\/diag-boot\.ts'\)\.then\(\(m\) => m\.startDiagBoot\(nextFrame\)\)\.catch\(\(\) => undefined\);\n\}/,
    );
    expect(main.match(/import\.meta\.env\.MODE !== 'production'/g)?.length).toBe(1);
    for (const key of [TL_ARM_KEY, SPLASH_ARM_KEY, 'lemo-run-log']) expect(main).not.toContain(key);
    for (const mod of ['run-log', 'vh-timeline', 'splash-probe', 'diag-boot']) expect(main).not.toMatch(new RegExp(`^import [^;]*${mod}`, 'm'));
    expect(main).not.toMatch(/SPLASH_HOLD_ATTR|cancelSplashHold/);
  });

  it('分包名登记进 PROBE_MARKERS（正式包不能带）', () => {
    expect(PROBE_MARKERS).toContain('diag-boot');
  });
});
