// 启动画面颜色诊断（台账 Q-2，platform/splash-probe.ts）：开关只跑一次；开着时 <html data-sp-probe>、小字、量尺都在；到点全部撤掉，DOM 回到原样；
// 入口只在 main.tsx 的非正式版分支里动态加载（正式构建摇掉，build/check_no_probe.mjs 登记了标记兜底）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARM_KEY, setSplashProbeArmed, splashProbeArmed } from '../splash-probe-arm.ts';
import { DURATION_MS, HOLD_HINT, PANEL_ID, startSplashProbe } from '../splash-probe.ts';
import { SPLASH_FADE_MS, SPLASH_HOLD_ATTR, SPLASH_HOLD_MS, SPLASH_MAX_MS } from '../splash.ts';
import { PROBE_MARKERS } from '../../../build/check_no_probe.mjs';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  const root = document.createElement('div');
  root.id = 'root';
  const splash = document.createElement('div');
  splash.id = 'lemo-splash';
  splash.className = 'lemo-splash';
  document.body.replaceChildren(root, splash);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete document.documentElement.dataset['spProbe'];
  delete document.documentElement.dataset[SPLASH_HOLD_ATTR];
});

describe('开关', () => {
  it('默认关；开、关存本机', () => {
    expect(splashProbeArmed()).toBe(false);
    setSplashProbeArmed(true);
    expect(localStorage.getItem(ARM_KEY)).toBe('1');
    setSplashProbeArmed(false);
    expect(localStorage.getItem(ARM_KEY)).toBeNull();
  });
});

describe('startSplashProbe', () => {
  it('开始就清掉开关（只跑一次），挂属性和小字；小字印出 innerHeight、screen、启动画面阶段', () => {
    setSplashProbeArmed(true);
    const before = [...document.body.children].map((n) => `${n.id}.${n.className}`);
    startSplashProbe();
    expect(splashProbeArmed()).toBe(false);
    expect(document.documentElement.dataset['spProbe']).toBe('1');
    const text = document.getElementById(PANEL_ID)?.textContent ?? '';
    expect(text).toContain(`inner=${window.innerWidth}x${window.innerHeight}`);
    expect(text).toContain('screen=');
    expect(text).toContain('phase=splash');
    expect(text).toContain('lvh=');
    expect(text).toContain('--lemo-screen-h=');
    expect(text.split('\n')[0]).toBe(HOLD_HINT); // 启动画面还在：小字第一行提示现在截图
    document.getElementById('lemo-splash')?.classList.add('is-leaving');
    vi.advanceTimersByTime(250);
    expect(document.getElementById(PANEL_ID)?.textContent).toContain('phase=leaving');
    expect(document.getElementById(PANEL_ID)?.textContent).not.toContain(HOLD_HINT);
    document.documentElement.dataset[SPLASH_HOLD_ATTR] = '1';
    vi.advanceTimersByTime(DURATION_MS);
    expect(document.documentElement.dataset['spProbe']).toBeUndefined();
    expect(document.documentElement.dataset[SPLASH_HOLD_ATTR]).toBeUndefined(); // 保留标记一起撤
    expect(document.getElementById(PANEL_ID)).toBeNull();
    document.getElementById('lemo-splash')?.classList.remove('is-leaving');
    expect([...document.body.children].map((n) => `${n.id}.${n.className}`)).toEqual(before);
  });

  it('返回的函数提前撤掉，重复调用安全', () => {
    const stop = startSplashProbe();
    stop();
    stop();
    expect(document.documentElement.dataset['spProbe']).toBeUndefined();
    expect(document.querySelectorAll('[class^="lemo-sp-probe"]')).toHaveLength(0);
  });
});

describe('启动画面多留 8 秒', () => {
  it('提示写明 8 秒；诊断撤掉晚于启动画面最晚收起（5 秒兜底 + 8 秒 + 淡出）', () => {
    expect(HOLD_HINT).toBe('Splash held 8s - screenshot now');
    const css = readFileSync(resolve(import.meta.dirname, '..', 'splash-probe.css'), 'utf8');
    expect(css).not.toMatch(/::before|data-hold/); // 提示文字在 TS 里，不用 CSS content 绕开 A20
    expect(SPLASH_HOLD_MS).toBe(8000);
    expect(DURATION_MS).toBeGreaterThan(SPLASH_MAX_MS + SPLASH_HOLD_MS + SPLASH_FADE_MS + 1000);
  });
  it('诊断样式停掉 splash.css 的 6 秒兜底淡出（不然 8 秒留不住）', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'splash-probe.css'), 'utf8');
    const at = css.indexOf(':root[data-sp-probe] #lemo-splash {');
    expect(css.slice(at, css.indexOf('}', at))).toContain('animation: none !important;');
  });
});

describe('接线', () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', '..', '..', p), 'utf8');
  it('main.tsx 只在非正式版分支里、开关开着才动态加载', () => {
    const main = read('src/app/main.tsx');
    const block = main.slice(main.indexOf("if (import.meta.env.MODE !== 'production') {"));
    expect(block).toMatch(/if \(localStorage\.getItem\('lemo-sp-color'\)\) \{\s*document\.documentElement\.dataset\[SPLASH_HOLD_ATTR\] = '1';\s*void import\('\.\.\/platform\/splash-probe\.ts'\)\.then\(\(m\) => m\.startSplashProbe\(\)\)\.catch\(\(\) => cancelSplashHold\('lemo-sp-color'\)\);/);
    expect(main.indexOf("import('../platform/splash-probe.ts')")).toBeGreaterThan(main.indexOf("if (import.meta.env.MODE !== 'production') {"));
    expect(main).not.toMatch(/^import .*splash-probe/m);
  });
  it('分包名、键名、类名登记进 PROBE_MARKERS', () => {
    for (const m of ['splash-probe', 'lemo-sp-color', 'sp-probe', 'splashHold']) expect(PROBE_MARKERS).toContain(m);
  });
  it('样式全挂在 data-sp-probe 或 lemo-sp-probe-* 下（关着时不影响任何元素）', () => {
    const css = read('src/platform/splash-probe.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => (m[2] ?? '').trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) expect(sel, sel).toMatch(/^(:root\[data-sp-probe\]|\.lemo-sp-probe-)/);
  });
});
