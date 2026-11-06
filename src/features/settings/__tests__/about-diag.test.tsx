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
});
