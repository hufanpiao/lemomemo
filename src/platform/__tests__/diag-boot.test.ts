// 非正式版的诊断启动件（platform/diag-boot.ts）：只起运行日志（一直开）；
// main.tsx 只在非正式版分支里动态 import 它这一处，入口里不读诊断开关（Gap fix 正式版也做，不经这里）。
// 启动画面收起不等它（台账 Q-2 的启动画面颜色诊断、R-371 冷启动时间线 11-12 删掉以后，再没有要先做的诊断）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROBE_MARKERS } from '../../../build/check_no_probe.mjs';
import { dropStaleKeys, logBootFailed, STALE_KEYS, startDiagBoot } from '../diag-boot.ts';
import { OUT_KEY as RUN_LOG_KEY } from '../run-log.ts';

beforeEach(() => localStorage.clear());

describe('startDiagBoot', () => {
  it('运行日志一直开；不跑 Gap fix', () => {
    startDiagBoot();
    expect(localStorage.getItem(RUN_LOG_KEY) ?? '').not.toBe('');
    expect(localStorage.getItem(RUN_LOG_KEY)).not.toMatch(/gapfix/);
  });

  it('R-409：空闲时才清掉两个旧键 lemo-gapfix-out、lemo-sp-color，别的键不动', () => {
    expect([...STALE_KEYS]).toEqual(['lemo-gapfix-out', 'lemo-sp-color']);
    for (const k of STALE_KEYS) localStorage.setItem(k, 'old');
    localStorage.setItem('lemo-gapfix-off', '1');
    let later: (() => void) | null = null;
    startDiagBoot(localStorage, (fn) => (later = fn));
    expect(localStorage.getItem('lemo-gapfix-out'), '没到空闲不清').toBe('old');
    (later as unknown as () => void)();
    for (const k of STALE_KEYS) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem('lemo-gapfix-off')).toBe('1');
    expect(localStorage.getItem(RUN_LOG_KEY) ?? '').not.toBe('');
  });

  it('启动失败那一行（logBootFailed）：只有错误名和固定说明；离开页面（pagehide）当场存进运行日志（第三方审查前端第 3 条）', () => {
    startDiagBoot(localStorage, () => undefined);
    const e = new TypeError('含用户内容的说明');
    logBootFailed(e);
    logBootFailed('不是 Error');
    window.dispatchEvent(new Event('pagehide'));
    const log = localStorage.getItem(RUN_LOG_KEY) ?? '';
    expect(log).toMatch(/app boot start_failed TypeError -> auth$/m);
    expect(log).toMatch(/app boot start_failed string -> auth$/m);
    expect(log).not.toContain('含用户内容');
  });

  it('R-409：存储抛错（隐私模式）也不往外抛', () => {
    const bad = { removeItem: () => { throw new DOMException('x', 'SecurityError'); } } as unknown as Storage;
    expect(() => dropStaleKeys(bad)).not.toThrow();
  });
});

/** main.tsx 里这一行原样（下面“接线”核对 main.tsx 里确实是这样写的） */
// 第三方审查前端第 3 条（11-14）起留下这个 Promise（diag），启动失败时经它的 logBootFailed 记一行再跳登录页
const DIAG = "const diag = import.meta.env.MODE !== 'production' ? import('../platform/diag-boot.ts').then((m) => (m.startDiagBoot(), m)).catch(() => undefined) : undefined;";

describe('接线', () => {
  const main = readFileSync(resolve(import.meta.dirname, '../../app/main.tsx'), 'utf8');
  const code = main.replace(/^\s*\/\/.*$/gm, '');
  it('main.tsx 只在非正式版分支里动态 import diag-boot 这一处；入口里不读诊断开关、不静态引诊断模块', () => {
    expect(code).toContain(DIAG);
    expect(main.match(/import\.meta\.env\.MODE !== 'production'/g)?.length).toBe(1);
    expect(main.match(/import\('\.\.\/platform\/diag-boot\.ts'\)/g)?.length).toBe(1);
    for (const key of ['lemo-vh-tl', 'lemo-sp-color', 'lemo-run-log']) expect(main).not.toContain(key);
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
