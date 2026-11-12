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

  it('诊断开着时（非正式版）下面有诊断按钮，平时没有；不再用的探测（可见高度、冷启动时间线 R-371，启动画面颜色 Q-2，键盘辅助条 Q-11，Gap fix 单独日志）都不在了', async () => {
    render(<AboutSection />);
    expect(screen.queryByTestId('settings-vh-probe')).toBeNull();
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const box = screen.getByTestId('settings-vh-probe');
    expect([...box.querySelectorAll('button')].map((b) => b.dataset['testid'])).toEqual(['vh-gapfix', 'vh-rl-send', 'vh-rl-copy', 'vh-rl-clear']);
  });

  it('Gap fix 开关默认 ON，点一下关掉用来对照（存本机 lemo-gapfix-off）、再点回 ON（R-371 11-11 默认开；日志在全局运行日志里）', async () => {
    localStorage.clear();
    render(<AboutSection />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const gf = screen.getByTestId('vh-gapfix');
    expect(gf.textContent).toBe('Gap fix: ON');
    expect(gf.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(gf);
    expect(gf.textContent).toBe('Gap fix: OFF (compare)');
    expect(gf.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('lemo-gapfix-off')).toBe('1');
    fireEvent.click(gf);
    expect(gf.textContent).toBe('Gap fix: ON');
    expect(localStorage.getItem('lemo-gapfix-off')).toBeNull();
    localStorage.clear();
  });
});
