// 待办页的动效（架构 17.1“勾选完成”“列表增删”，17.4 B2；B2 FA-5）：
// 打勾当下圆圈就填满（不等保存回来）；撤销条开着的约 3 秒里留在原处，再从原来的组离开（不接点按、移出文档流）、归进默认收起的“已完成 N”（负责人 11-15）；
// 删除先淡出再卸载、撤销恢复后淡入。时间上的手感由 e2e（b2-motion-list）和连续帧确认，这里证明结构和状态
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感，先等它到（真实页面里首屏画完后才有人操作）
await loadMotionFeatures();

// 留住的那一拍（useHoldView，--dur-ui）只假 setTimeout：断言“还在原处”之前计时器不会因为机器忙先到期
// （真计时器下点击到断言若超过 220 ms 就会误判，前端 B 三时区并发跑时出现过）；推进完切回真计时器，Motion 的帧照常跑
const HOLD_MS = 220;
const holdTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

type Row = { id: string } & Record<string, unknown>;
const db = { rows: [] as Row[], subs: new Set<() => void>() };
const put = (rows: Row[]) => {
  db.rows = rows;
  for (const f of db.subs) f();
};
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: () =>
    useSyncExternalStore(
      (f: () => void) => {
        db.subs.add(f);
        return () => db.subs.delete(f);
      },
      () => db.rows,
    ),
}));
// 保存由测试决定什么时候“回来”
let finish: () => void = () => undefined;
const patch = (id: string, p: Record<string, unknown>) => put(db.rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
vi.mock('../../../core/todo-done.ts', () => ({
  doneToggler: () => (r: Row, done: boolean) =>
    new Promise((ok) => {
      finish = () => {
        patch(r.id, { done, done_at: done ? 1 : null });
        ok('saved');
      };
    }),
}));
vi.mock('../data/todo-actions.ts', () => ({
  setTodoDeleted: async (r: Row, deleted: boolean) => {
    patch(r.id, { deleted_at: deleted ? 1 : null });
    return 'saved';
  },
}));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(Date.UTC(2026, 10, 5, 0));
  put([
    { id: 'a', title: '买牛奶', done: false },
    { id: 'b', title: '写周报', done: false },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset['rm'];
});

const row = (id: string) => screen.queryByTestId(`todos-row-${id}`);

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
const fill = (el: HTMLElement | null) => el?.querySelector('[data-state="on"], [data-state="off"]')?.getAttribute('data-state');

describe('待办页动效', () => {
  it('进页面：行直接到位（不逐条入场）；圆盘、勾号对读屏隐藏', () => {
    render(<TodosPage />);
    expect(row('a')?.style.opacity).not.toBe('0');
    expect(fill(row('a'))).toBe('off');
    for (const s of row('a')?.querySelectorAll('span[data-state]') ?? []) expect(s.getAttribute('aria-hidden')).toBe('true');
  });

  it('打勾：当下圆盘就是 on（保存还没回来）、页底出“已完成 · 撤销”；撤销条开着的约 3 秒里留在原组，收起以后旧行离开（leaving、移出文档流），归进默认收起的“已完成 N”', async () => {
    render(<TodosPage />);
    holdTimers();
    fireEvent.click(screen.getByTestId('todos-done-a'));
    expect(fill(row('a'))).toBe('on');
    expect(screen.getByTestId('todos-done-toast').textContent).toContain('已完成');
    await act(async () => finish());
    // 留住的那一拍（--dur-ui）过了，撤销条还开着：仍在原来的组、圆盘 on，“已完成”组还没出现
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(screen.queryByTestId('todos-g-done')).toBeNull();
    expect(fill(within(screen.getByTestId('todos-g-nodate')).getByTestId('todos-row-a'))).toBe('on');
    const rec = recordStates('todos-row-a');
    // 撤销条到时收起（3 秒）：这一条离开原组
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    vi.useRealTimers();
    expect(screen.queryByTestId('todos-done-toast')).toBeNull();
    const fold = await screen.findByTestId('todos-done-fold', {}, { timeout: 3000 });
    expect(rec.seen.some((s) => s.ancestors.includes('todos-g-nodate') && s.state === 'leaving' && s.position === 'absolute')).toBe(true);
    rec.stop();
    await waitFor(() => expect(within(screen.getByTestId('todos-g-nodate')).queryByTestId('todos-row-a')).toBeNull(), { timeout: 3000 });
    // 默认收起：只有“已完成 1 ›”一行，里面的行不画；点开展开、再点收起
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toContain('已完成 1');
    expect(within(screen.getByTestId('todos-g-done')).queryByTestId('todos-row-a')).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fill(within(screen.getByTestId('todos-g-done')).getByTestId('todos-row-a'))).toBe('on');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(within(screen.getByTestId('todos-g-done')).queryByTestId('todos-row-a')).toBeNull(), { timeout: 3000 });
  });

  it('打勾的撤销条点“撤销”：这一条改回没完成、留在原组，撤销条收起，不出“已完成”组', async () => {
    render(<TodosPage />);
    fireEvent.click(screen.getByTestId('todos-done-a'));
    await act(async () => finish());
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('todos-done-toast')).getByRole('button'));
    });
    await act(async () => finish());
    expect(screen.queryByTestId('todos-done-toast')).toBeNull();
    expect(db.rows.find((r) => r.id === 'a')?.['done']).toBe(false);
    await waitFor(() => expect(fill(within(screen.getByTestId('todos-g-nodate')).getByTestId('todos-row-a'))).toBe('off'), { timeout: 3000 });
    expect(screen.queryByTestId('todos-g-done')).toBeNull();
  });

  it('留住的那一拍里能再点回去：两次都在原处，最后不挪', async () => {
    render(<TodosPage />);
    holdTimers();
    fireEvent.click(screen.getByTestId('todos-done-a'));
    await act(async () => finish());
    fireEvent.click(screen.getByTestId('todos-done-a'));
    expect(fill(row('a'))).toBe('off');
    await act(async () => finish());
    // 不用真实时间等（FA-5 复审 N4）：留住的那一拍只靠 setTimeout，把排着的计时器全部跑完，再看整个过程里有没有出现过 leaving
    const rec = recordStates('todos-row-a');
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    rec.stop();
    expect(rec.seen.filter((x) => x.state === 'leaving')).toEqual([]);
    expect(screen.queryByTestId('todos-g-done')).toBeNull();
    expect(row('a')?.dataset['state']).toBeUndefined();
  });

  it('删除：先淡出（leaving）再卸载；撤销恢复：淡入（起点透明）', async () => {
    render(<TodosPage />);
    const del = recordStates('todos-row-b');
    await act(async () => {
      // 删除在左滑露出的“删除”上（负责人 11-15 去掉 ×）；手势本身在 kit 的 SwipeRow.test.tsx 和 e2e todos-swipe 里测，这里只看删行的动效
      fireEvent.click(screen.getByTestId('todos-swipe-del-b'), { detail: 1 });
    });
    // 点删除那一次提交当下就是 leaving（不读 act 返回后的状态：淡出只有 110 ms）
    expect(del.seen.some((s) => s.state === 'leaving')).toBe(true);
    del.stop();
    await waitFor(() => expect(row('b')).toBeNull(), { timeout: 3000 });
    const undo = recordStates('todos-row-b');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('todos-toast')).getByRole('button'));
    });
    // 撤销那一次提交当下（起点，代码审查 M1）：重新插进来的这一行全透明、entering（淡入播完以前不接点按）
    expect(undo.seen[0]).toMatchObject({ state: 'entering' });
    expect(Number(undo.seen[0]?.opacity)).toBe(0);
    undo.stop();
    // 播完恢复（只等结果，不看中间状态）
    await waitFor(() => expect(row('b')?.dataset['state']).toBeUndefined(), { timeout: 3000 });
  });
});
