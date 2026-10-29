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
