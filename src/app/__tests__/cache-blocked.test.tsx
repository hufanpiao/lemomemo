// 升级本机库被别的标签页挡住（TC-B1-48 的 blocked；架构师 10-30 第 8 点）：coldStart 还在等库打开时整屏提示
// “请关掉其他打开的柠檬记窗口”，画出来后收起启动画面；库打开（blocked 变回 false）后自动消失
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';

const hideSplash = vi.fn(() => Promise.resolve());
vi.mock('../../platform/splash.ts', () => ({ hideSplash: () => hideSplash() }));
vi.mock('../../motion/index.ts', () => ({ nextFrame: (fn: () => void) => (fn(), () => undefined) }));

afterEach(() => {
  cleanup();
  document.getElementById('lemo-blocked')?.remove();
});

function center() {
  return createUpgradeCenter({ appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(), attempt: { get: () => null, set: () => undefined } });
}

describe('watchCacheBlocked', () => {
  it('blocked 变成 true：整屏提示出现（role=alert，有标题和说明），收起启动画面；变回 false：自动消失、容器删掉', async () => {
    const { watchCacheBlocked } = await import('../root.tsx');
    const u = center();
    watchCacheBlocked(u);
    expect(document.getElementById('lemo-blocked')).toBeNull();

    await act(async () => u.setBlocked(true));
    const box = document.querySelector('[data-testid="cache-blocked"]');
    expect(box?.getAttribute('role')).toBe('alert');
    expect(box?.textContent).toContain('请关掉其他打开的柠檬记窗口');
    expect(document.getElementById('cache-blocked-body')?.textContent).toContain('关掉以后这里会自动接着打开');
    expect(hideSplash).toHaveBeenCalled();

    await act(async () => u.setBlocked(false));
    expect(document.getElementById('lemo-blocked')).toBeNull();
    expect(document.querySelector('[data-testid="cache-blocked"]')).toBeNull();
  });

  it('取消订阅时一起卸掉；之后再 blocked 也不出', async () => {
    const { watchCacheBlocked } = await import('../root.tsx');
    const u = center();
    const off = watchCacheBlocked(u);
    await act(async () => u.setBlocked(true));
    expect(document.getElementById('lemo-blocked')).not.toBeNull();
    await act(async () => off());
    expect(document.getElementById('lemo-blocked')).toBeNull();
    await act(async () => {
      u.setBlocked(false);
      u.setBlocked(true);
    });
    expect(document.getElementById('lemo-blocked')).toBeNull();
  });
});

describe('blocked 解除后等 #root 画出东西再卸（BANNER-sugg ①）', () => {
  /** 手动推进的“下一帧” */
  function frames() {
    const q: (() => void)[] = [];
    return { frame: (cb: () => void) => (q.push(cb), () => void q.splice(q.indexOf(cb), 1)), flush: () => q.splice(0).forEach((f) => f()) };
  }
  function appRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'root';
    document.body.appendChild(el);
    return el;
  }
  afterEach(() => {
    vi.useRealTimers();
    document.getElementById('root')?.remove();
  });

  it('#root 还空着：解除后整屏提示留着；#root 画出东西的下一帧才卸', async () => {
    const { watchCacheBlocked } = await import('../root.tsx');
    const app = appRoot();
    const f = frames();
    const u = center();
    watchCacheBlocked(u, { frame: f.frame });
    await act(async () => u.setBlocked(true));
    await act(async () => u.setBlocked(false));
    expect(document.querySelector('[data-testid="cache-blocked"]')).not.toBeNull();
    await act(async () => {
      app.appendChild(document.createElement('main'));
      await Promise.resolve();   // MutationObserver 是微任务
    });
    expect(document.getElementById('lemo-blocked')).not.toBeNull();
    await act(async () => f.flush());
    expect(document.getElementById('lemo-blocked')).toBeNull();
  });

  it('#root 已经有内容：下一帧就卸', async () => {
    const { watchCacheBlocked } = await import('../root.tsx');
    appRoot().appendChild(document.createElement('main'));
    const f = frames();
    const u = center();
    watchCacheBlocked(u, { frame: f.frame });
    await act(async () => u.setBlocked(true));
    await act(async () => u.setBlocked(false));
    expect(document.getElementById('lemo-blocked')).not.toBeNull();
    await act(async () => f.flush());
    expect(document.getElementById('lemo-blocked')).toBeNull();
  });

  it('#root 一直不画（换账号、回登录页）：最多等 releaseMaxMs 就卸', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watchCacheBlocked, BLOCKED_RELEASE_MAX_MS } = await import('../root.tsx');
    appRoot();
    const u = center();
    watchCacheBlocked(u, { frame: frames().frame });
    await act(async () => u.setBlocked(true));
    await act(async () => u.setBlocked(false));
    await act(async () => vi.advanceTimersByTime(BLOCKED_RELEASE_MAX_MS - 1));
    expect(document.getElementById('lemo-blocked')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.getElementById('lemo-blocked')).toBeNull();
  });

  it('等的时候又被挡住：接着显示，不会被之前的等待卸掉', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watchCacheBlocked, BLOCKED_RELEASE_MAX_MS } = await import('../root.tsx');
    appRoot();
    const u = center();
    watchCacheBlocked(u, { frame: frames().frame });
    await act(async () => u.setBlocked(true));
    await act(async () => u.setBlocked(false));
    await act(async () => u.setBlocked(true));
    await act(async () => vi.advanceTimersByTime(BLOCKED_RELEASE_MAX_MS * 2));
    expect(document.querySelector('[data-testid="cache-blocked"]')).not.toBeNull();
    expect(document.querySelectorAll('#lemo-blocked')).toHaveLength(1);
  });
});

describe('blocked 第一次为 true 时才定界面语言（BANNER-sugg ③）', () => {
  it('没被挡住不调 onFirstBlocked；第一次挡住在画整屏提示之前调一次，之后再挡不再调', async () => {
    const { watchCacheBlocked } = await import('../root.tsx');
    const u = center();
    const seen: (Element | null)[] = [];
    const onFirstBlocked = vi.fn(() => void seen.push(document.getElementById('lemo-blocked')));
    watchCacheBlocked(u, { onFirstBlocked });
    expect(onFirstBlocked).not.toHaveBeenCalled();
    await act(async () => u.setBlocked(true));
    expect(onFirstBlocked).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]);
    await act(async () => u.setBlocked(false));
    await act(async () => u.setBlocked(true));
    expect(onFirstBlocked).toHaveBeenCalledTimes(1);
  });

  it('main.tsx：onUpgradeCenter 不再无条件按“没有 profile”定语言，交给 onFirstBlocked；按 boot 定过以后不覆盖', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/app/main.tsx', 'utf8');
    const hook = /onUpgradeCenter: \(u\) => \{([\s\S]*?)\n {4}\},/.exec(src)?.[1] ?? '';
    expect(hook).toContain('onFirstBlocked');
    expect(hook).toMatch(/localeFromBoot \? undefined : applyLocale\(\{ profile: null \}\)/);
    expect(hook.replace(/onFirstBlocked[\s\S]*$/, '')).not.toContain('applyLocale');
    expect(src).toMatch(/applyLocale\(boot\);\n {2}localeFromBoot = true;/);
  });
});
