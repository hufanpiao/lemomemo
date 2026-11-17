// 今天页的动效（架构 17.1“勾选完成”“列表增删”；B2 FA-5）：没赶上的一条打勾——圆圈当下就填满（不等保存回来）；
// 按勾选完成时间线（11-17 起今天页和待办页同一个 kit TodoRow、useDoneFlow）先在原处停 HOLD_MS、再原地收起 OUT_MS（data-out），
// 收完再离开“没赶上”（是最后一条时整组一起淡出；不接点按、移出文档流，播完才卸载）。数据层用替身，“现在”卡不在这里测
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感，先等它到（真实页面里首屏画完后才有人操作）
await loadMotionFeatures();

let finish: () => void = () => undefined;
let setLate: (v: unknown[]) => void = () => undefined;
const lateRow = { todo: { id: 'a', title: '交房租', dueTime: null }, days: 2 };
vi.mock('../hooks/useToday.ts', () => ({
  // 同真的 useToday：留位（linger）里的那一条保存回来了也先留在原处，留位放掉才拿掉
  useToday: (linger: ReadonlySet<string>) => {
    const [late, set] = useState<unknown[]>([lateRow]);
    setLate = set;
    return {
      today: '2026-11-05', tz: 'Asia/Seoul', now: 0, card: null, tomorrowFirst: null, late: late.length || !linger.has('a') ? late : [lateRow], events: [], todos: [],
      subs: new Map(),
      toggleDone: () => new Promise((ok) => {
        finish = () => {
          set([]);
          ok('ok');
        };
      }),
      remove: async () => 'ok',
    };
  },
}));
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => null }));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

// 停留、收起两个计时（kit useDoneFlow 的 HOLD_MS、OUT_MS）只假 setTimeout：断言“还在原处”之前计时器不会因为机器忙先到期
//（前端 B 三时区并发跑时出现过）；推进完切回真计时器，Motion 的帧照常跑
const { HOLD_MS, OUT_MS } = await import('../../../kit/components/useDoneFlow.ts');

/**
 * 记下某个 testid 元素每次 DOM 变化时的状态（代码审查 FA5-CR M1）：MutationObserver 的回调是微任务，
 * 一定早于 Motion 的任何一帧（rAF），所以读到的是“那一次提交当下”的状态，不依赖真实时间里动画进行到哪儿。
 * ancestors：往上所有带 data-testid 的祖先（看它在哪一组）
 */
function recordStates(testid: string) {
  const seen: { state: string | undefined; opacity: string; position: string; ancestors: string[] }[] = [];
  const mo = new MutationObserver(() => {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)) {
      const ancestors: string[] = [];
      for (let p = el.parentElement?.closest('[data-testid]'); p; p = p.parentElement?.closest('[data-testid]')) ancestors.push(p.getAttribute('data-testid') ?? '');
      seen.push({ state: el.dataset['state'], opacity: el.style.opacity, position: el.style.position, ancestors });
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'style'] });
  return { seen, stop: () => mo.disconnect() };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setLate([lateRow]);
});

describe('今天页动效', () => {
  it('没赶上的一条打勾：圆盘当下 on；原处停 HOLD_MS、收起 OUT_MS（data-out），收完整组离开（leaving、移出文档流），播完才卸载', async () => {
    uiStore.getState().setLocale('zh-CN');
    render(<TodayPage />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const box = screen.getByTestId('today-done-a');
    const row = box.closest('li') as HTMLElement;
    expect(row.querySelector('span[data-state]')?.getAttribute('data-state')).toBe('off');
    fireEvent.click(box);
    expect(row.querySelector('span[data-state]')?.getAttribute('data-state')).toBe('on');
    await act(async () => finish());
    // 保存回来了，还在停留的那一段里：这一行原地不动、圆盘 on、还没开始收起
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS - 1);
    });
    expect(row.closest('[data-state="leaving"]')).toBeNull();
    expect(row.hasAttribute('data-out')).toBe(false);
    expect(row.querySelector('span[data-state]')?.getAttribute('data-state')).toBe('on');
    // 到点：原地收起（data-out），还在“没赶上”里
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(row.hasAttribute('data-out')).toBe(true);
    expect(row.isConnected).toBe(true);
    const rec = recordStates('today-late');
    await act(async () => {
      vi.advanceTimersByTime(OUT_MS);
    });
    vi.useRealTimers();
    // 收完：最后一条离开，整组“没赶上”跟着淡出、移出文档流（读的是离开那一次提交当下记下的状态，不靠 waitFor 赶在淡出播完之前）
    expect(rec.seen.some((s) => s.state === 'leaving' && s.position === 'absolute')).toBe(true);
    rec.stop();
    await waitFor(() => expect(row.isConnected).toBe(false), { timeout: 3000 });
  });
});
