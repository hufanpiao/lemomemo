// 版本横幅固定在顶部（R-281，负责人 10-30“有新版本这个提醒应该固定在上面”）：横幅量出自己的高度写进 <html> 的 --banner-h，
// #root 按它让出位置（base.css）；高度变了跟着改，横幅没了就去掉。jsdom 不算布局，offsetHeight 用桩
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter } from '../../core/upgrade.ts';
import { UpdateBanner } from '../UpdateBanner.tsx';

afterEach(cleanup);

function center() {
  const u = createUpgradeCenter({ appVersion: '4.0.0', reload: vi.fn(), swUpdate: vi.fn(async () => 'failed' as const), attempt: { get: () => null, set: () => undefined } });
  return { u };
}

describe('横幅高度写进 --banner-h（R-281）', () => {
  it('R-281：横幅出现就把自己的高度写进 <html> 的 --banner-h（#root 按它让出位置），高度变了跟着改，横幅没了就去掉', () => {
    let h = 64;
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => h);
    let onResize: (() => void) | null = null;
    const disconnect = vi.fn();
    class FakeRO {
      constructor(cb: () => void) {
        onResize = cb;
      }
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    try {
      const { u } = center();
      render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
      const css = () => document.documentElement.style.getPropertyValue('--banner-h');
      expect(css()).toBe('');
      act(() => u.setSwReady());
      expect(css()).toBe('64px');
      h = 85;
      act(() => onResize?.());
      expect(css()).toBe('85px');
      act(() => u.dismissSwReady());
      expect(css()).toBe('');
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('R-281：没有 ResizeObserver 的环境也量一次、横幅没了照样去掉', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(70);
    try {
      const { u } = center();
      render(<UpdateBanner upgrade={u} outbox={null} onReload={vi.fn()} />);
      act(() => u.setSwReady());
      expect(document.documentElement.style.getPropertyValue('--banner-h')).toBe('70px');
      act(() => u.dismissSwReady());
      expect(document.documentElement.style.getPropertyValue('--banner-h')).toBe('');
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

});
