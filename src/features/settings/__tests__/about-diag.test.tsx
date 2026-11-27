// 设置 › 关于：3 秒内连点“版本”5 下显示诊断信息、再连点 5 下收起；点得慢、点别处不算（11-06，主屏幕版真机排查）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepDiagOn } from '../../../platform/diag-deep.ts';
import { AboutSection, DIAG_TAPS, DIAG_WINDOW_MS } from '../ui/AboutSection.tsx';
import { DD_LABEL_OFF, DD_LABEL_ON } from '../ui/VhProbe.tsx';

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
    render(<AboutSection onCredits={() => undefined} />);
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
    render(<AboutSection onCredits={() => undefined} />);
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

  it('诊断开着时 <html> 带 data-diag="1"；离开设置页还留着，回来时文字也在，连点 5 下关掉才摘', async () => {
    const root = document.documentElement;
    const v = render(<AboutSection onCredits={() => undefined} />);
    expect(root.hasAttribute('data-diag')).toBe(false);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    expect(root.dataset['diag']).toBe('1');
    v.unmount();
    expect(root.dataset['diag']).toBe('1');
    render(<AboutSection onCredits={() => undefined} />);
    await screen.findByTestId('settings-about-diag');
    tapVersion(DIAG_TAPS);
    await act(async () => undefined);
    expect(screen.queryByTestId('settings-about-diag')).toBeNull();
    expect(root.hasAttribute('data-diag')).toBe(false);
  });

  it('诊断开着时（非正式版）下面有诊断按钮，平时没有；不再用的探测（可见高度、冷启动时间线 R-371，启动画面颜色 Q-2，键盘辅助条 Q-11，Gap fix 单独日志，11-24 删掉的 Gap fix 总开关和四套对照开关）都不在了', async () => {
    render(<AboutSection onCredits={() => undefined} />);
    expect(screen.queryByTestId('settings-vh-probe')).toBeNull();
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const box = screen.getByTestId('settings-vh-probe');
    expect([...box.querySelectorAll('button')].map((b) => b.dataset['testid'])).toEqual(['vh-haptic', 'vh-gemini-live', 'vh-fx-warm', 'vh-deep-diag', 'vh-rl-send', 'vh-rl-copy', 'vh-rl-clear']);
  });

  it('深度诊断开关默认 OFF，点一下 ON（只存这次打开 sessionStorage）、再点回 OFF（11-20 改善报告第四节，platform/diag-deep.ts）', async () => {
    sessionStorage.clear();
    render(<AboutSection onCredits={() => undefined} />);
    tapVersion(DIAG_TAPS);
    const btn = await screen.findByTestId('vh-deep-diag');
    expect(btn.textContent).toBe(DD_LABEL_OFF);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.textContent).toBe(DD_LABEL_ON);
    expect(deepDiagOn()).toBe(true);
    expect(localStorage.getItem('lemo-diag-deep')).toBeNull();
    fireEvent.click(btn);
    expect(btn.textContent).toBe(DD_LABEL_OFF);
    expect(deepDiagOn()).toBe(false);
  });

  // Gemini live（11-24）：关掉只用录音上传（516 的做法）对照用。Live speech 随系统识别那一支 11-24 删掉，下面单测它不在了
  it.each([
    ['vh-gemini-live', 'Gemini live', 'lemo-gemini-live-off'],
  ])('%s 开关默认 ON，点成 OFF 存 sessionStorage 的对应键（只管这次打开），再点回 ON', async (id, name, key) => {
    sessionStorage.clear();
    render(<AboutSection onCredits={() => undefined} />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const ls = screen.getByTestId(id);
    expect(ls.textContent).toBe(`${name}: ON`);
    fireEvent.click(ls);
    expect(ls.textContent).toBe(`${name}: OFF (compare)`);
    expect(ls.getAttribute('aria-pressed')).toBe('false');
    expect(sessionStorage.getItem(key)).toBe('1');
    fireEvent.click(ls);
    expect(ls.textContent).toBe(`${name}: ON`);
    expect(sessionStorage.getItem(key)).toBeNull();
    sessionStorage.clear();
  });

  it('Live speech 开关不在了（系统识别那一支 11-24 删掉）', async () => {
    render(<AboutSection onCredits={() => undefined} />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    expect(screen.queryByTestId('vh-live-speech')).toBeNull();
  });

  it('Finger switch 是看得见的系统开关（带 switch 属性），手指点了记运行日志 probe finger switch on=（负责人 11-18“震动没反应”对照用）', async () => {
    localStorage.clear();
    render(<AboutSection onCredits={() => undefined} />);
    tapVersion(DIAG_TAPS);
    await screen.findByTestId('settings-about-diag');
    const sw = screen.getByTestId('vh-finger-switch') as HTMLInputElement;
    expect(sw.type).toBe('checkbox');
    expect(sw.hasAttribute('switch')).toBe(true);
    expect(sw.closest('label')?.textContent).toContain('Finger switch');
    fireEvent.click(sw);
    expect(sw.checked).toBe(true);
    localStorage.clear();
  });
});
