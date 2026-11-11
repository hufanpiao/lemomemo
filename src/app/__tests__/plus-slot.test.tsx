// “＋”点一下打开打字条的接线（app/plus-slot.tsx；B3 FA-2、M4、Q4）：
// • 没打开、没预先下载：什么都不画，也不下载打字条那一块
// • 还没下载好就打开：过 PREPARING_DELAY_MS 显示“准备中”（不能点了没反应），可以关掉；到了换成打字条，日子原样交过去
// • 首屏画完以后 preloadPlus：挂一份小气泡（什么都不画）；之后打开直接是打字条，不闪“准备中”；展开、关闭原样交回
// • 预先下载好以后打开：打开的那一次渲染当场画出（Q-24，iOS 弹键盘的前提）。这条排在任何画出打字条的用例前面：
//   万一以后有人改回 React.lazy，lazy 成功一次就缓存，排在后面就测不出来
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../kit/state/ui-store.ts';

const gate = vi.hoisted(() => ({ bars: 0, preloads: 0, mounts: 0, ready: Promise.resolve() }));
vi.mock('../../features/plus/index.ts', async () => {
  const { createElement, lazy } = await import('react');
  type P = { day: string | null; onExpand(text: string, day: string | null): void; onClose(): void };
  const Bar = ({ day, onExpand, onClose }: P) =>
    createElement('div', { 'data-testid': 'type-bar-stub', 'data-day': day ?? '' }, [
      createElement('button', { key: 'e', type: 'button', onClick: () => onExpand('hi', day) }, 'expand'),
      createElement('button', { key: 'c', type: 'button', onClick: onClose }, 'close'),
    ]);
  const Preload = () => {
    gate.mounts += 1;
    return null;
  };
  return {
    routes: [],
    loadTypeBar: async () => {
      gate.bars += 1;
      await gate.ready;
      return { default: Bar };
    },
    TypeBarPreload: lazy(async () => {
      gate.preloads += 1;
      await gate.ready;
      return { default: Preload };
    }),
  };
});

const { PlusSlot, preloadPlus, resetPlusForTest, PREPARING_DELAY_MS } = await import('../plus-slot.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  resetPlusForTest();
});

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
const noop = () => undefined;

describe('PlusSlot', () => {
  it('没打开、没预先下载：什么都不画，也不下载', async () => {
    const { container } = render(<PlusSlot open={false} day={null} onExpand={noop} onClose={noop} />);
    await wait(10);
    expect(container.childElementCount).toBe(0);
    expect(gate.bars + gate.preloads).toBe(0);
  });

  // Q-24（负责人 11-11“点+不出来键盘，还要点输入框才出来键盘”；运行日志 7 次冷启动后第一次点＋，focusin 都晚 310～480ms、键盘没弹）：
  // iOS 只在点按的同一个任务里 focus 才弹键盘，打字条必须在打开的那一次渲染里当场画出来，不许挂起等下一拍
  it('预先下载好以后打开：同一次渲染当场画出打字条，不挂起（iOS 才会弹键盘）', async () => {
    const { rerender } = render(<PlusSlot open={false} day={null} onExpand={noop} onClose={noop} />);
    act(() => preloadPlus());
    await wait(10);
    act(() => rerender(<PlusSlot open day={null} onExpand={noop} onClose={noop} />));
    expect(screen.queryByTestId('type-bar-stub'), '打开的那一次就要在').not.toBeNull();
  });

  it('还没下载好就打开：晚一点显示“准备中”，能关；到了换成打字条', async () => {
    let arrive!: () => void;
    gate.ready = new Promise<void>((ok) => (arrive = ok));
    const onClose = vi.fn();
    render(<PlusSlot open day="2026-11-09" onExpand={noop} onClose={onClose} />);
    expect(screen.queryByTestId('plus-preparing'), '不立刻闪出来').toBeNull();
    await wait(PREPARING_DELAY_MS + 50);
    const box = screen.getByTestId('plus-preparing');
    expect(box.textContent).toContain('准备中');
    expect(box.getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    arrive();
    await wait(20);
    expect(screen.queryByTestId('plus-preparing')).toBeNull();
    expect(screen.getByTestId('type-bar-stub').dataset['day']).toBe('2026-11-09');
    gate.ready = Promise.resolve();
  });

  it('预先下载以后：挂一份什么都不画的预先下载；打开直接是打字条，不闪“准备中”；展开、关闭原样交回', async () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    const { container, rerender } = render(<PlusSlot open={false} day={null} onExpand={onExpand} onClose={onClose} />);
    const mounts = gate.mounts;
    act(() => preloadPlus());
    await wait(10);
    expect(gate.mounts).toBeGreaterThan(mounts);
    expect(container.childElementCount, '预先下载什么都不画').toBe(0);
    rerender(<PlusSlot open day={null} onExpand={onExpand} onClose={onClose} />);
    await wait(PREPARING_DELAY_MS + 50);
    expect(screen.queryByTestId('plus-preparing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'expand' }));
    expect(onExpand).toHaveBeenCalledWith('hi', null);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
