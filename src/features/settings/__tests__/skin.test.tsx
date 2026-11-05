// 设置 › 皮肤 › 倾斜高光（TILT-b2 做法 ②；主持人 11-05：开关在设置页、存本机、默认关；iOS 的方向权限只在用户打开开关时申请）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { TILT_KEY, readTiltPref } from '../data/local.ts';
import { SkinSection } from '../ui/SkinSection.tsx';

beforeEach(() => {
  act(() => uiStore.getState().setLocale('zh-CN'));
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const sw = (): HTMLInputElement => screen.getByRole('switch', { name: '倾斜高光' });

describe('设置 › 皮肤 › 倾斜高光', () => {
  it('默认关；有组标题“皮肤”、说明', () => {
    const ask = vi.fn(async () => true);
    render(<SkinSection deps={{ ask }} />);
    expect(screen.getByRole('heading', { name: '皮肤' })).toBeTruthy();
    expect(sw().checked).toBe(false);
    expect(sw().getAttribute('aria-describedby')).toBe('settings-skin-tilt-note');
    expect(ask).not.toHaveBeenCalled(); // 不打开就不问权限
  });

  it('打开：在这次点按里申请权限（同步发起），同意了才记成开，底栏那边读得到；关掉不问权限', async () => {
    const ask = vi.fn(async () => true);
    render(<SkinSection deps={{ ask }} />);
    await act(async () => {
      fireEvent.click(sw());
      expect(ask).toHaveBeenCalledTimes(1); // 点按处理里同步调用（iOS 只认点按里的 requestPermission）
    });
    expect(sw().checked).toBe(true);
    expect(readTiltPref()).toBe(true);
    await act(async () => {
      fireEvent.click(sw());
    });
    expect(sw().checked).toBe(false);
    expect(localStorage.getItem(TILT_KEY)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('拒绝：保持关，提示一句（role=status）；再打开成功提示消失', async () => {
    let ok = false;
    const ask = vi.fn(async () => ok);
    render(<SkinSection deps={{ ask }} />);
    await act(async () => {
      fireEvent.click(sw());
    });
    expect(sw().checked).toBe(false);
    expect(localStorage.getItem(TILT_KEY)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('没有拿到方向数据的权限，倾斜高光没开。彻底退出柠檬记、重新进来后，再打开这个开关试一次。');
    ok = true;
    await act(async () => {
      fireEvent.click(sw());
    });
    expect(sw().checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('本机已经开着：进来就是开；写不进本机（隐私模式）时打开后仍显示关', async () => {
    localStorage.setItem(TILT_KEY, '1');
    const view = render(<SkinSection deps={{ ask: async () => true }} />);
    expect(sw().checked).toBe(true);
    view.unmount();
    localStorage.clear();
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined } as unknown as Storage;
    render(<SkinSection deps={{ ask: async () => true, storage: broken }} />);
    await act(async () => {
      fireEvent.click(sw());
    });
    expect(sw().checked).toBe(false);
  });

  it('韩文', () => {
    act(() => uiStore.getState().setLocale('ko-KR'));
    render(<SkinSection deps={{ ask: async () => true }} />);
    expect(screen.getByRole('switch', { name: '기울기 하이라이트' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '스킨' })).toBeTruthy();
  });
});
