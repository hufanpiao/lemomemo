// 倾斜授权试验页 src/public/diag/tilt.{html,js,css}（R-153，架构 0.27 第 5 点；TC-B1-55；iPhone 实机验收清单 P1-05）：
// ① 守 /app/* 的 CSP：没有内联脚本、内联样式、事件属性，脚本里不写 style 属性（只用 CSSOM 写两个自定义属性）；
// ② 加载时不调 requestPermission，只在点按回调里调，两个接口在同一次点按里同步发起；
// ③ 打开后没点按就收到读数判“记得住”，2 秒内没有读数判“记不住”，点得太早判“这次不算”；
// ④ 读数只放内存：脚本里没有任何存储、网络、日志调用
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIAG = join(ROOT, 'src', 'public', 'diag');
const pageHtml = readFileSync(join(DIAG, 'tilt.html'), 'utf8');
const jsText = readFileSync(join(DIAG, 'tilt.js'), 'utf8');

interface TiltModule {
  AUTO_WAIT_MS: number;
  highlightPos(beta: number | null, gamma: number | null): { sx: number; sy: number };
  fmtDeg(v: unknown): string;
  startRequest(Ctor: unknown): Promise<string>;
  run(doc: Document, win: unknown): { tapped: boolean; decided: boolean; orient: number; motion: number };
}

let mod: TiltModule;
beforeAll(async () => {
  mod = (await import(pathToFileURL(join(DIAG, 'tilt.js')).href)) as TiltModule;
});

function mountPage(): void {
  const parsed = new DOMParser().parseFromString(pageHtml, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
}

type Listener = (e: unknown) => void;

/** 假 window：记下挂了哪些监听、requestPermission 被调了几次；用 vitest 的假定时器 */
function fakeWin(opts: { ios: boolean; answer?: string }) {
  const listeners = new Map<string, Listener[]>();
  const calls: string[] = [];
  const ctor = (name: string) =>
    opts.ios
      ? {
          requestPermission: () => {
            calls.push(name);
            return Promise.resolve(opts.answer ?? 'granted');
          },
        }
      : {};
  const win = {
    Date,
    performance: { now: () => Date.now(), getEntriesByType: () => [{ type: 'navigate' }] },
    navigator: { standalone: true },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    DeviceOrientationEvent: ctor('DeviceOrientationEvent'),
    DeviceMotionEvent: ctor('DeviceMotionEvent'),
  };
  const fire = (type: string, e: unknown) => (listeners.get(type) ?? []).forEach((fn) => fn(e));
  return { win, calls, listeners, fire };
}

const text = (id: string) => document.getElementById(id)?.textContent ?? '';

describe('倾斜授权试验页', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mountPage();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('守 CSP：脚本、样式都是同源单独文件，没有内联脚本、内联样式、事件属性', () => {
    expect(pageHtml).toMatch(/<script type="module" src="\.\/tilt\.js"><\/script>/);
    expect(pageHtml).toMatch(/<link rel="stylesheet" href="\.\/tilt\.css" \/>/);
    expect([...pageHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].every((m) => (m[1] ?? '').trim() === '')).toBe(true);
    expect(pageHtml).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
    expect(jsText).not.toMatch(/inner[H]TML|outer[H]TML|insertAdjacentHTML|setAttribute\(\s*['"]style|\.style\.cssText/);
    // 只用 CSSOM 写高光位置的两个自定义属性（CSSOM 不受 style-src 限制，e2e 在 chromium、webkit 里核对没有 CSP 报错）
    const styleUses = [...jsText.matchAll(/\.style\.(\w+)\(\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(styleUses).toEqual(['setProperty --sx', 'setProperty --sy']);
    // 不挂 manifest、不注册 SW：添加到主屏幕后打开的就是这一页，也不会装上 App 的 SW
    expect(pageHtml).not.toMatch(/rel="manifest"/);
    expect(jsText).not.toMatch(/serviceWorker/);
  });

  it('读数只放内存：脚本里没有存储、网络、日志调用', () => {
    // 去掉注释再查（文件开头的说明里会写到这些词）
    const code = jsText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie|caches\b/i);
    expect(code).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\(/);
    expect(code).not.toMatch(/console\./);
  });

  it('加载时不调 requestPermission；点按时两个接口在同一次点按里同步发起', async () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    expect(f.calls).toEqual([]);
    expect([...f.listeners.keys()].sort()).toEqual(['devicemotion', 'deviceorientation']);
    document.getElementById('ask')?.click();
    // 同步就已经调了两个，不等第一个的结果
    expect(f.calls).toEqual(['DeviceOrientationEvent', 'DeviceMotionEvent']);
    await vi.runAllTimersAsync();
    expect(text('perm')).toContain('DeviceOrientationEvent允许（granted）');
    expect(text('perm')).toContain('DeviceMotionEvent允许（granted）');
  });

  it('打开后没点按就收到读数：判“授权还在 → 记得住”，读数和高光跟着变', () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    vi.advanceTimersByTime(300);
    f.fire('deviceorientation', { alpha: 120, beta: 30, gamma: -10 });
    expect(text('auto')).toContain('授权还在 → 记得住');
    expect(document.getElementById('auto')?.dataset.verdict).toBe('kept');
    expect(text('live')).toContain('30.0°');
    expect(text('live')).toContain('-10.0°');
    const glass = document.getElementById('glass') as HTMLElement;
    expect(glass.style.getPropertyValue('--sx')).toBe('34.0%');
    expect(glass.style.getPropertyValue('--sy')).toBe('-21.0%');
    // 之后超时也不改判
    vi.advanceTimersByTime(mod.AUTO_WAIT_MS);
    expect(document.getElementById('auto')?.dataset.verdict).toBe('kept');
  });

  it('只收到 devicemotion 也算收到读数', () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    f.fire('devicemotion', { accelerationIncludingGravity: { x: 0.1, y: -9.8, z: 0.3 } });
    expect(document.getElementById('auto')?.dataset.verdict).toBe('kept');
    expect(text('live')).toContain('0.10 / -9.80 / 0.30');
  });

  it('2 秒内没读数：判“授权不在 → 记不住”；之后点按授权、读数照常显示，但不改判', async () => {
    const f = fakeWin({ ios: true, answer: 'denied' });
    mod.run(document, f.win);
    f.fire('deviceorientation', { alpha: null, beta: null, gamma: null }); // 空读数不算
    vi.advanceTimersByTime(mod.AUTO_WAIT_MS);
    expect(text('auto')).toContain('授权不在 → 记不住');
    expect(document.getElementById('auto')?.dataset.verdict).toBe('lost');
    document.getElementById('ask')?.click();
    await vi.runAllTimersAsync();
    expect(text('perm')).toContain('拒绝（denied）');
    f.fire('deviceorientation', { alpha: 0, beta: 45, gamma: 0 });
    expect(document.getElementById('auto')?.dataset.verdict).toBe('lost');
  });

  it('判“记不住”之后、没点过按钮才第一次收到读数：#auto 后补一句“结论可能有误，请重测”，不改判', () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    const late = document.getElementById('late') as HTMLElement;
    expect(late.hidden).toBe(true);
    vi.advanceTimersByTime(2500);
    expect(document.getElementById('auto')?.dataset.verdict).toBe('lost');
    f.fire('deviceorientation', { alpha: 0, beta: 45, gamma: 0 });
    expect(late.hidden).toBe(false);
    expect(late.textContent).toBe('第 2500 毫秒才收到读数，结论可能有误，请重测');
    expect(late.previousElementSibling?.id).toBe('auto');
    expect(document.getElementById('auto')?.dataset.verdict).toBe('lost');
    // 只在第一笔读数时补一次，后面的读数不改这句
    vi.advanceTimersByTime(100);
    f.fire('deviceorientation', { alpha: 0, beta: 40, gamma: 0 });
    expect(late.textContent).toBe('第 2500 毫秒才收到读数，结论可能有误，请重测');
  });

  it('判“记不住”后先点了按钮再收到读数：是授权后的正常读数，不补“可能有误”', async () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    vi.advanceTimersByTime(mod.AUTO_WAIT_MS);
    document.getElementById('ask')?.click();
    await vi.runAllTimersAsync();
    f.fire('deviceorientation', { alpha: 0, beta: 45, gamma: 0 });
    expect((document.getElementById('late') as HTMLElement).hidden).toBe(true);
    expect(document.getElementById('auto')?.dataset.verdict).toBe('lost');
  });

  it('判“记得住”时不出“可能有误”这句', () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    f.fire('deviceorientation', { alpha: 0, beta: 45, gamma: 0 });
    vi.advanceTimersByTime(mod.AUTO_WAIT_MS * 2);
    expect((document.getElementById('late') as HTMLElement).hidden).toBe(true);
  });

  it('自动检测出结果前就点了按钮：这次不算，提示划掉重开', () => {
    const f = fakeWin({ ios: true });
    mod.run(document, f.win);
    vi.advanceTimersByTime(500);
    document.getElementById('ask')?.click();
    expect(document.getElementById('auto')?.dataset.verdict).toBe('early');
    f.fire('deviceorientation', { alpha: 0, beta: 45, gamma: 0 });
    vi.advanceTimersByTime(mod.AUTO_WAIT_MS);
    expect(document.getElementById('auto')?.dataset.verdict).toBe('early');
  });

  it('不是 iPhone 的 Safari（没有 requestPermission）：说明这里看不出结论，点按不报错', async () => {
    const f = fakeWin({ ios: false });
    mod.run(document, f.win);
    expect(text('env')).toContain('不要（没有 requestPermission');
    document.getElementById('ask')?.click();
    await vi.runAllTimersAsync();
    expect(text('perm')).toContain('不需要授权');
    expect(document.getElementById('auto')?.dataset.verdict).toBe('early');
  });

  it('startRequest：requestPermission 同步抛错或 reject 都变成中文结果，不往外抛', async () => {
    const boom = (): never => {
      throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
    };
    await expect(mod.startRequest({ requestPermission: boom })).resolves.toBe('出错：NotAllowedError');
    await expect(
      mod.startRequest({ requestPermission: () => Promise.reject(Object.assign(new Error('x'), { name: 'SecurityError' })) }),
    ).resolves.toBe('出错：SecurityError');
    await expect(mod.startRequest(undefined)).resolves.toBe('这个浏览器没有这个接口');
  });

  it('高光位置照试验页第 2 版的算法，倾角超出范围时夹住', () => {
    expect(mod.highlightPos(45, 0)).toEqual({ sx: 50, sy: -30 });
    expect(mod.highlightPos(null, null)).toEqual({ sx: 50, sy: -30 });
    expect(mod.highlightPos(-20, 90)).toEqual({ sx: 50 + 35 * 1.6, sy: -30 + 45 * 0.6 });
    expect(mod.fmtDeg(null)).toBe('—');
    expect(mod.fmtDeg(12.345)).toBe('12.3°');
  });
});
