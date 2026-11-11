// “＋”上方的小气泡（B3 S23）：开关、exe、次数、跟着“＋”的位置，键盘弹起或“＋”不在时不出
import { act, cleanup, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as Hint from '../data/plus-hint.ts';

const launch = vi.fn();
vi.mock('../data/plus-hint.ts', async (orig) => ({ ...(await orig<typeof Hint>()), plusHintThisLaunch: () => launch() }));
const { markPlusHeld, resetPlusHintForTest } = await import('../data/plus-hint.ts');
const { spotOf } = await import('../hooks/usePlusHint.ts');
const { default: PlusHint } = await import('../ui/PlusHint.tsx');

function addFab(rect: Partial<DOMRect>, kb = false): HTMLElement {
  const b = document.createElement('button');
  b.setAttribute('data-testid', 'tabbar-add');
  if (kb) document.documentElement.setAttribute('data-kbhide', '1');
  b.getBoundingClientRect = () => ({ top: 0, right: 0, width: 0, height: 0, left: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect;
  document.body.appendChild(b);
  return b;
}

beforeEach(() => {
  uiStore.setState({ locale: 'zh-CN' });
  launch.mockResolvedValue(true);
  vi.stubGlobal('innerWidth', 375);
  vi.stubGlobal('innerHeight', 812);
});
afterEach(() => {
  cleanup();
  resetPlusHintForTest();
  document.querySelectorAll('[data-testid="tabbar-add"]').forEach((e) => e.remove());
  document.documentElement.removeAttribute('data-kbhide');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('spotOf', () => {
  it('右边和“＋”对齐，底边在“＋”上方 10px', () => {
    const fab = addFab({ top: 740, right: 359, width: 56, height: 56 });
    expect(spotOf(fab, 375, 812)).toEqual({ right: 16, bottom: 82 });
  });
  it('“＋”不在、键盘弹起藏起、尺寸为 0 → null', () => {
    expect(spotOf(null, 375, 812)).toBeNull();
    expect(spotOf(addFab({ top: 740, right: 359, width: 56, height: 56 }, true), 375, 812)).toBeNull();
    expect(spotOf(addFab({}), 375, 812)).toBeNull();
  });
});

async function mount(props: { enabled?: boolean; exe?: boolean }): Promise<void> {
  await act(async () => {
    render(<PlusHint {...props} />);
    await Promise.resolve();
  });
}

describe('PlusHint', () => {
  it('打开开关、前 3 次：在“＋”上方显示“按住说话 · 点一下打字”，不挡点按', async () => {
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    const el = screen.getByTestId('plus-hint');
    expect(el.textContent).toBe('按住说话 · 点一下打字');
    expect(el.getAttribute('role')).toBe('note');
    expect(el.style.right).toBe('16px');
    expect(el.style.bottom).toBe('82px');
  });

  it('开关关着：不出，也不记次数', async () => {
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: false, exe: false });
    expect(screen.queryByTestId('plus-hint')).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('exe 不出（R-90），也不记次数', async () => {
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: true });
    expect(screen.queryByTestId('plus-hint')).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('已经过了 3 次或按住过：不出', async () => {
    launch.mockResolvedValue(false);
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    expect(screen.queryByTestId('plus-hint')).toBeNull();
  });

  it('键盘弹起把“＋”藏起来：气泡跟着收起，落下再出来', async () => {
    vi.useFakeTimers();
    try {
      addFab({ top: 740, right: 359, width: 56, height: 56 });
      await mount({ enabled: true, exe: false });
      expect(screen.getByTestId('plus-hint')).toBeTruthy();
      await act(async () => {
        document.documentElement.setAttribute('data-kbhide', '1');
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.queryByTestId('plus-hint')).toBeNull();
      await act(async () => {
        document.documentElement.removeAttribute('data-kbhide');
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.getByTestId('plus-hint')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('韩文', async () => {
    uiStore.setState({ locale: 'ko-KR' });
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    expect(screen.getByTestId('plus-hint').textContent).toBe('누르고 말하기 · 탭해서 입력');
  });
});

describe('代码审建议 1、3（11-10）', () => {
  it('“＋”位置没变：resize 后不重画', async () => {
    vi.useFakeTimers();
    try {
      addFab({ top: 740, right: 359, width: 56, height: 56 });
      let commits = 0;
      await act(async () => {
        render(
          <Profiler id="h" onRender={() => (commits += 1)}>
            <PlusHint enabled exe={false} />
          </Profiler>,
        );
        await Promise.resolve();
      });
      expect(screen.getByTestId('plus-hint')).toBeTruthy();
      const before = commits;
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(commits).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('本机库还没准备好（null）：先不出，换页时再查，准备好了就出', async () => {
    launch.mockResolvedValueOnce(null).mockResolvedValue(true);
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    expect(screen.queryByTestId('plus-hint')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('plus-hint')).toBeTruthy();
  });

  it('按住过一次（markPlusHeld）：气泡当场收起', async () => {
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    expect(screen.getByTestId('plus-hint')).toBeTruthy();
    act(() => {
      void markPlusHeld(1, null);
    });
    expect(screen.queryByTestId('plus-hint')).toBeNull();
  });
});

describe('S23 复审 R1（11-10）', () => {
  it('读写出错（null）以后不摘换页监听：之后每次换页都再查，直到查成', async () => {
    launch.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(true);
    addFab({ top: 740, right: 359, width: 56, height: 56 });
    await mount({ enabled: true, exe: false });
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(launch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('plus-hint')).toBeTruthy();
    // 查成以后摘掉监听：再换页不再查
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(launch).toHaveBeenCalledTimes(3);
  });
});

