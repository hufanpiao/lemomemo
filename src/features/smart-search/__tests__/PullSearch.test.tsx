// 下拉搜索的搜索框和结果（R-437；ui/PullSearch.tsx、hooks/usePullFind.ts）：打字当场出结果、点一条交给页面、“用 AI 按意思找”打开查找面板、
// 取消、Esc 清空收起、从“搜索本页”打开的自动聚焦、读屏的条数去抖、运行日志只记数不记字
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collection } from '../../../core/store.ts';
import { PullSlot } from '../../../kit/components/PullSlot.tsx';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { closeFind, findOpenSnapshot } from '../hooks/find-open.ts';
import { SEM_DEBOUNCE_MS } from '../hooks/find-consts.ts';
import PullSearch from '../ui/PullSearch.tsx';
import type { PullScope } from '../hooks/usePullFind.ts';

const fx = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false, updated_at: NOW };
type R = { id: string } & Record<string, unknown>;
const put = (name: string, rows: R[]) => collection<R>(name).upsert(rows);

function Host({ scope, onOpen }: { scope: PullScope; onOpen(id: string): void }) {
  const pull = usePullReveal('test');
  return (
    <main ref={pull.ref}>
      <button type="button" onClick={() => pull.reveal('touch')}>open</button>
      <PullSlot pull={pull} keyLabel="搜索本页" search={<PullSearch pull={pull} scope={scope} onOpen={onOpen} />}>
        <p data-testid="page-list">list</p>
      </PullSlot>
    </main>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  uiStore.getState().setLocale('zh-CN');
  fx.logs.length = 0;
});
afterEach(() => {
  cleanup();
  closeFind();
  for (const c of ['notes', 'categories', 'todos', 'todo_items', 'events']) collection(c).clear();
  vi.useRealTimers();
});

const typeQ = (v: string) => fireEvent.change(screen.getByTestId('pull-input'), { target: { value: v } });

describe('下拉搜索', () => {
  it('随手记：打字当场出结果、本页列表让位；点一条交给页面；隐私记不出；日志只记字数和条数', () => {
    put('notes', [
      { id: id(1), ...live, title: '证件照', body: '护照和身份证都拍了', category_id: null, is_private: false, created_at: NOW },
      { id: id(2), ...live, title: '证件密码', body: '', category_id: null, is_private: true, created_at: NOW },
    ]);
    const onOpen = vi.fn();
    render(<Host scope="note" onOpen={onOpen} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('pull-input').getAttribute('placeholder')).toBe('搜索随手记');
    expect(screen.queryByTestId('pull-results')).toBeNull();
    typeQ('证件');
    expect(screen.getByTestId('pull-keep').hidden).toBe(true);
    expect(screen.getByTestId('pull-count').textContent).toBe('找到 1 条');
    fireEvent.click(screen.getByTestId(`pull-row-${id(1)}`));
    expect(onOpen).toHaveBeenCalledWith(id(1));
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(fx.logs).toContain('pull open test via=touch');
    expect(fx.logs.some((l) => /^pull find note len=2 n=1 ms=\d+$/.test(l))).toBe(true);
    expect(fx.logs.join('\n')).not.toContain('证件');
  });

  it('“用 AI 按意思找”：打开查找面板（openFind，from=pull），带上打的字；没找到时也有这一行', () => {
    render(<Host scope="event" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    typeQ(' 证件 ');
    expect(screen.getByTestId('pull-count').textContent).toBe('没有按字找到');
    fireEvent.click(screen.getByTestId('pull-ai'));
    expect(findOpenSnapshot()).toMatchObject({ q: '证件', from: 'pull', assist: null });
    expect(fx.logs).toContain('pull ai event n=0');
  });

  it('待办靠子任务命中：第二行写“子任务：…”', () => {
    put('todos', [{ id: id(3), ...live, title: '出差准备', note: '', project: '', due: null, done: false }]);
    put('todo_items', [{ id: id(4), ...live, todo_id: id(3), title: '带护照', done: false, sort: 1 }]);
    render(<Host scope="todo" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    typeQ('护照');
    expect(screen.getByTestId(`pull-row-${id(3)}`).textContent).toContain('子任务：带护照');
  });

  it('“×”只清空、搜索框留着；“取消”清空并收起', () => {
    render(<Host scope="note" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    typeQ('abc');
    fireEvent.click(screen.getByTestId('pull-clear'));
    expect(screen.getByTestId('pull-search')).toBeTruthy();
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    typeQ('abc');
    fireEvent.click(screen.getByTestId('pull-cancel'));
    expect(screen.queryByTestId('pull-search')).toBeNull();
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    expect(fx.logs).toContain('pull close test');
  });

  it('从“搜索本页”打开：输入框自动聚焦；输入框里按 Esc 清空收起，焦点回到“搜索本页”', () => {
    render(<Host scope="note" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(document.activeElement).toBe(screen.getByTestId('pull-input'));
    typeQ('abc');
    fireEvent.keyDown(screen.getByTestId('pull-input'), { key: 'Escape' });
    expect(screen.queryByTestId('pull-search')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('pull-key'));
    expect(fx.logs.slice(0, 2)).toEqual(['pull open test via=key', 'pull close test']);
  });

  it('下拉打开的不抢焦点（手指还按着，弹键盘会顶乱页面）', () => {
    render(<Host scope="note" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    expect(document.activeElement).not.toBe(screen.getByTestId('pull-input'));
  });

  it('读屏：常驻的 role=status 停 SEM_DEBOUNCE_MS 才写条数，连着打字不一个字播一遍；清空后也清掉', () => {
    put('notes', [{ id: id(5), ...live, title: '牛奶', body: '', category_id: null, is_private: false, created_at: NOW }]);
    render(<Host scope="note" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    typeQ('x');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS / 2));
    typeQ('牛奶');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS / 2));
    expect(status.textContent).toBe('');
    // 看得见的条数照常跟手
    expect(screen.getByTestId('pull-count').textContent).toBe('找到 1 条');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(status.textContent).toBe('找到 1 条');
    expect(screen.getByRole('status')).toBe(status);
    typeQ('');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(status.textContent).toBe('');
  });
});
