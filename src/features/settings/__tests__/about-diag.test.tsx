// 设置 › 关于：3 秒内连点“版本”5 下显示诊断信息、再连点 5 下收起；点得慢、点别处不算（11-06，主屏幕版真机排查）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutSection, DIAG_TAPS, DIAG_WINDOW_MS } from '../ui/AboutSection.tsx';

const tapVersion = (n: number) => {
  for (let k = 0; k < n; k++) fireEvent.click(screen.getByTestId('settings-about-version-value'));
};

describe('关于页的诊断信息', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.removeAttribute('data-diag');
  });

  it('平时不显示；连点 5 下显示，第一行是构建提交号；再连点 5 下收起', async () => {
    render(<AboutSection />);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
    tapVersion(DIAG_TAPS - 1);
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
    tapVersion(1);
    const pre = await screen.findByTestId('settings-about-diag');
    expect(pre.textContent?.split('\n')[0]).toMatch(/^build: commit=\S+ version=/);
    expect(pre.textContent).toMatch(/\nsw/);
    tapVersion(DIAG_TAPS);
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
  });

  it('点得慢（超过 3 秒才点满 5 下）不算；点卡片下面的说明文字也不算', async () => {
    render(<AboutSection />);
    for (let k = 0; k < DIAG_TAPS; k++) {
      tapVersion(1);
      vi.setSystemTime(Date.now() + DIAG_WINDOW_MS / 2);
    }
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
    for (let k = 0; k < DIAG_TAPS; k++) fireEvent.click(screen.getByTestId('settings-lunar-credit'));
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
  });

  it('诊断开着时 <html> 带 data-diag="1"（顶部红、蓝诊断色条靠它显示）；离开设置页还留着，回来时文字也在，连点 5 下关掉才摘', async () => {
    const root = document.documentElement;
    const v = render(<AboutSection />);
    expect(root.hasAttribute('data-diag')).toBe(false);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    expect(root.dataset['diag']).toBe('1');
    v.unmount();
    expect(root.dataset['diag']).toBe('1');
    render(<AboutSection />);
    await screen.findByTestId('settings-about-diag');
    tapVersion(DIAG_TAPS);
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
    expect(root.hasAttribute('data-diag')).toBe(false);
  });

  it('诊断开着时（非正式版）下面有可见高度探测按钮，平时没有（R-371 第二条路）', async () => {
    render(<AboutSection />);
    expect(screen.queryByTestId('settings-vh-probe')).toBeNull();
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    expect(screen.getByTestId('settings-vh-probe')).toBeTruthy();
    expect(screen.getByTestId('vh-probe-meta-height')).toBeTruthy();
  });
});
