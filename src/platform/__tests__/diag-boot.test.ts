// 非正式版的诊断启动件（platform/diag-boot.ts）：运行日志一直开；冷启动时间线按诊断页开关；
// main.tsx 只在非正式版分支里动态 import 它这一处，入口里不再读诊断开关（Gap fix 正式版也做，不经这里）。
// 启动画面收起不等它（台账 Q-2 的启动画面颜色诊断 11-12 删掉以后，再没有要先打的“多留”标记）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROBE_MARKERS } from '../../../build/check_no_probe.mjs';
import { startDiagBoot } from '../diag-boot.ts';
import { OUT_KEY as RUN_LOG_KEY } from '../run-log.ts';
import { ARM_KEY as TL_ARM_KEY, OUT_KEY as TL_OUT_KEY } from '../vh-timeline.ts';

/** 只收不跑的“帧”：只看启动那一刻做了什么 */
const frame = (_cb: () => void): void => undefined;

beforeEach(() => localStorage.clear());

describe('startDiagBoot', () => {
  it('运行日志一直开；时间线开关没开不记、开着记一次并关掉开关；不跑 Gap fix', () => {
    startDiagBoot(frame);
    expect(localStorage.getItem(RUN_LOG_KEY) ?? '').not.toBe('');
    expect(localStorage.getItem(TL_OUT_KEY)).toBeNull();
    localStorage.setItem(TL_ARM_KEY, '1');
    startDiagBoot(frame);
    expect(localStorage.getItem(TL_ARM_KEY)).toBeNull();
    expect(localStorage.getItem(TL_OUT_KEY)).not.toBeNull();
    expect(localStorage.getItem(RUN_LOG_KEY)).not.toMatch(/gapfix/);
  });
});

/** main.tsx 里这一行原样（下面“接线”核对 main.tsx 里确实是这样写的） */
const DIAG = "if (import.meta.env.MODE !== 'production') void import('../platform/diag-boot.ts').then((m) => m.startDiagBoot(nextFrame)).catch(() => undefined);";

describe('接线', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../app/main.tsx'), 'utf8');
  const code = main.replace(/^\s*\/\/.*$/gm, '');
  it('main.tsx 只在非正式版分支里动态 import diag-boot 这一处；入口里不读诊断开关、不静态引诊断模块', () => {
    expect(code).toContain(DIAG);
    expect(main.match(/import\.meta\.env\.MODE !== 'production'/g)?.length).toBe(1);
    expect(main.match(/import\('\.\.\/platform\/diag-boot\.ts'\)/g)?.length).toBe(1);
    for (const key of [TL_ARM_KEY, 'lemo-sp-color', 'lemo-run-log']) expect(main).not.toContain(key);
    for (const mod of ['run-log', 'vh-timeline', 'splash-probe', 'diag-boot']) expect(main).not.toMatch(new RegExp(`^import [^;]*${mod}`, 'm'));
    expect(main).not.toMatch(/SPLASH_HOLD_ATTR|cancelSplashHold|diagReady|leaveSplash/);
  });

  it('5 秒兜底和 #root 画出东西这两处直接收启动画面，不等诊断', () => {
    expect(code).toMatch(/^hideSplashAfter\(hideSplash\);$/m);
    expect(code).toContain('whenContent(() => void nextFrame(() => void hideSplash()));');
    // #root 画出东西那一处，加上 start() 里冷启动就进退出屏的两处（还没挂 #root）
    expect(code.match(/hideSplash\(\)/g)?.length).toBe(3);
  });

  it('分包名登记进 PROBE_MARKERS（正式包不能带）', () => {
    expect(PROBE_MARKERS).toContain('diag-boot');
  });
});
