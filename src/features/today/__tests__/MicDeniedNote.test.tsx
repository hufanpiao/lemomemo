// 麦克风被拒时今天页常驻的一行（B3 S23）：先看记下的结果不闪，再以 Permissions API 为准；exe 不出
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as Env from '../../../platform/env.ts';

const last = vi.fn();
const ask = vi.fn();
let exe = false;
let ios = true;
vi.mock('../../../platform/perm-mic.ts', () => ({ lastMicResult: () => last(), micPermission: () => ask() }));
vi.mock('../../../platform/env.ts', async (orig) => ({ ...(await orig<typeof Env>()), isTauri: () => exe, isAppleMobile: () => ios }));
const { default: MicDeniedNote } = await import('../ui/MicDeniedNote.tsx');

const ZH = '麦克风没有打开，语音用不了。可以在 iPhone 的“设置”里给这个 App 打开麦克风。';

beforeEach(() => {
  exe = false;
  ios = true;
  uiStore.setState({ locale: 'zh-CN' });
  last.mockReturnValue(null);
  ask.mockResolvedValue('unknown');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mount(): Promise<void> {
  await act(async () => {
    render(<MicDeniedNote />);
    await Promise.resolve();
  });
}

describe('MicDeniedNote', () => {
  it('记下的是被拒、系统也说被拒：显示这一行（文案照线框原文）', async () => {
    last.mockReturnValue('denied');
    ask.mockResolvedValue('denied');
    await mount();
    expect(screen.getByTestId('today-mic-denied').textContent).toBe(ZH);
  });

  it('第一次画就按记下的结果出来，不等异步', () => {
    last.mockReturnValue('denied');
    ask.mockReturnValue(new Promise(() => undefined));
    render(<MicDeniedNote />);
    expect(screen.getByTestId('today-mic-denied')).toBeTruthy();
  });

  it('用户在系统里重新打开了：以 Permissions API 为准，这一行消失', async () => {
    last.mockReturnValue('denied');
    ask.mockResolvedValue('granted');
    await mount();
    expect(screen.queryByTestId('today-mic-denied')).toBeNull();
  });

  it('没被拒、没问过：不画', async () => {
    await mount();
    expect(screen.queryByTestId('today-mic-denied')).toBeNull();
  });

  it('exe 不出（R-90），也不去问', async () => {
    exe = true;
    last.mockReturnValue('denied');
    await mount();
    expect(screen.queryByTestId('today-mic-denied')).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('韩文', async () => {
    uiStore.setState({ locale: 'ko-KR' });
    ask.mockResolvedValue('denied');
    await mount();
    expect(screen.getByTestId('today-mic-denied').textContent).toMatch(/^마이크가 꺼져 있어서/);
  });
});

describe('按设备分两套（R-367，负责人 11-10）', () => {
  it('iOS：线框原文（带 iPhone）', async () => {
    ask.mockResolvedValue('denied');
    await mount();
    expect(screen.getByTestId('today-mic-denied').textContent).toBe(ZH);
  });

  it('非 iOS：浏览器的通用说法，不带 iPhone', async () => {
    ios = false;
    ask.mockResolvedValue('denied');
    await mount();
    expect(screen.getByTestId('today-mic-denied').textContent).toBe('麦克风没有打开，语音用不了。可以在浏览器的设置里给这个网站打开麦克风。');
  });

  it('非 iOS · 韩文', async () => {
    ios = false;
    uiStore.setState({ locale: 'ko-KR' });
    ask.mockResolvedValue('denied');
    await mount();
    const text = screen.getByTestId('today-mic-denied').textContent ?? '';
    expect(text).toContain('브라우저 설정에서 이 사이트의 마이크를 켜 주세요');
    expect(text).not.toContain('iPhone');
  });
});

