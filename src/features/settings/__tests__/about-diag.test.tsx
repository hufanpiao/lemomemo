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

  it('时间线开关点一下开、再点关（存本机）；没记过时“Copy timeline”不能点，记过了显示整段、点了复制整段（R-371 冷启动时间线）', async () => {
    localStorage.clear();
    render(<AboutSection />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const arm = screen.getByTestId('vh-tl-arm');
    expect(arm.textContent).toBe('Timeline next launch: OFF');
    expect(arm.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(arm);
    expect(arm.textContent).toBe('Timeline next launch: ON');
    expect(localStorage.getItem('lemo-vh-tl')).toBe('1');
    fireEvent.click(arm);
    expect(arm.textContent).toBe('Timeline next launch: OFF');
    expect(localStorage.getItem('lemo-vh-tl')).toBeNull();
    expect((screen.getByTestId('vh-tl-copy') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('vh-tl-out')).toBeNull();
    cleanup();

    localStorage.setItem('lemo-vh-tl-out', 'vh-timeline start=x\nt=0.25 inner=894');
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AboutSection />);
    await screen.findByTestId('settings-about-diag');
    expect(screen.getByTestId('vh-tl-out').textContent).toBe('vh-timeline start=x\nt=0.25 inner=894');
    localStorage.setItem('lemo-vh-tl-out', 'vh-timeline start=x\nt=0.25 inner=894\nt=0.50 inner=956');
    fireEvent.click(screen.getByTestId('vh-tl-copy'));
    expect(writeText).toHaveBeenCalledWith('vh-timeline start=x\nt=0.25 inner=894\nt=0.50 inner=956');
    expect(await screen.findByText('Copied')).toBeTruthy();
    localStorage.clear();
  });

  it('Gap fix 开关点一下开、再点关（存本机 lemo-gapfix）；有日志时显示最近一次冷启动的日志（R-371 修复候选）', async () => {
    localStorage.clear();
    render(<AboutSection />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const gf = screen.getByTestId('vh-gapfix');
    expect(gf.textContent).toBe('Gap fix: OFF');
    expect(gf.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('vh-gapfix-out')).toBeNull();
    fireEvent.click(gf);
    expect(gf.textContent).toBe('Gap fix: ON');
    expect(localStorage.getItem('lemo-gapfix')).toBe('1');
    fireEvent.click(gf);
    expect(gf.textContent).toBe('Gap fix: OFF');
    expect(localStorage.getItem('lemo-gapfix')).toBeNull();
    cleanup();

    localStorage.setItem('lemo-gapfix-out', 'gapfix start=x\nt=0 pad gap=61 top=61');
    render(<AboutSection />);
    await screen.findByTestId('settings-about-diag');
    expect(screen.getByTestId('vh-gapfix-out').textContent).toBe('gapfix start=x\nt=0 pad gap=61 top=61');
    localStorage.clear();
  });

  it('时间线、Gap fix 两个开关能同时开；Gap fix 日志一键复制（按时重新读本机），没日志时复制键灰着（R-371 11-10 复审）', async () => {
    localStorage.clear();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AboutSection />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    expect((screen.getByTestId('vh-gapfix-copy') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('vh-tl-arm'));
    fireEvent.click(screen.getByTestId('vh-gapfix'));
    expect(localStorage.getItem('lemo-vh-tl')).toBe('1');
    expect(localStorage.getItem('lemo-gapfix')).toBe('1');
    expect(screen.getByTestId('vh-tl-arm').textContent).toBe('Timeline next launch: ON');
    expect(screen.getByTestId('vh-gapfix').textContent).toBe('Gap fix: ON');
    cleanup();

    localStorage.setItem('lemo-gapfix-out', 'gapfix start=x');
    render(<AboutSection />);
    await screen.findByTestId('settings-about-diag');
    localStorage.setItem('lemo-gapfix-out', 'gapfix start=x\nt=0 skip no-gap(0)');
    fireEvent.click(screen.getByTestId('vh-gapfix-copy'));
    expect(writeText).toHaveBeenCalledWith('gapfix start=x\nt=0 skip no-gap(0)');
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(screen.getByTestId('vh-gapfix-out').textContent).toBe('gapfix start=x\nt=0 skip no-gap(0)');
    localStorage.clear();
  });
});
