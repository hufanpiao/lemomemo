// 下拉搜索（R-437；负责人 11-22“搜索部分日历，代办跟，随手记，统一全部查找”“不分”“搜索框里不需要有字”；ui/PullSearch.tsx、hooks/usePullFind.ts）：
// • 三页同一种：打了字本页藏起来，结果在搜索框下面列，日程、待办、随手记混在一起；框里不放提示字；框下一行条数；结果下面“用 AI 按意思找”，搜不到时居中提示
// • 点一条：本页这一类交给页面（own），别的类按类换页
// • 取消、Esc 清空收起、从“搜索”打开的自动聚焦、读屏的条数去抖、运行日志只记数不记字
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collection } from '../../../core/store.ts';
import { PullSlot } from '../../../kit/components/PullSlot.tsx';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { closeFind, findOpenSnapshot } from '../hooks/find-open.ts';
import { SEM_DEBOUNCE_MS } from '../hooks/find-consts.ts';
import PullSearch, { type PullSearchProps } from '../ui/PullSearch.tsx';

const fx = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false, updated_at: NOW };
type R = { id: string } & Record<string, unknown>;
const put = (name: string, rows: R[]) => collection<R>(name).upsert(rows);

/** 页面的样子：本页一块列表（打了字藏起来），上面挂搜索框 */
/** tag：页名（usePullReveal 的，日志里用它） */
function Host({ tag, own }: { tag: string; own?: PullSearchProps['own'] }) {
  const pull = usePullReveal(tag);
  return (
    <main ref={pull.ref}>
      <button type="button" onClick={() => pull.reveal('touch')}>open</button>
      <PullSlot pull={pull} keyLabel="搜索" search={<PullSearch pull={pull} own={own} />}>
        <ul data-testid="page-list" />
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
  it('不管在哪一页，日程、待办、随手记一起查、混在一起列；框里不放提示字；隐私记不出；条数、“用 AI 按意思找”；日志只记字数和条数', () => {
    put('notes', [
      { id: id(1), ...live, title: '证件照', body: '护照和身份证都拍了', category_id: null, is_private: false, created_at: NOW },
      { id: id(2), ...live, title: '证件密码', body: '', category_id: null, is_private: true, created_at: NOW },
    ]);
    put('todos', [
      { id: id(3), ...live, title: '出差准备', note: '', project: '', due: null, done: false },
      { id: id(5), ...live, title: '证件续签', note: '', project: '', due: null, done: true },
    ]);
    put('todo_items', [{ id: id(4), ...live, todo_id: id(3), title: '带证件', done: false, sort: 1 }]);
    put('events', [{ id: id(6), ...live, title: '办证件', date: '2026-11-20', start_time: '10:00', all_day: false, location: '', note: '' }]);
    render(<Host tag="todo" />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('pull-input').getAttribute('placeholder')).toBeNull();
    expect(screen.getByTestId('pull-input').getAttribute('aria-label')).toBe('搜索');
    expect(screen.queryByTestId('pull-count')).toBeNull();
    expect(screen.queryByTestId('pull-ai')).toBeNull();
    typeQ('证件');
    expect(screen.getByTestId('pull-keep').hidden).toBe(true);
    for (const n of [1, 3, 5, 6]) expect(screen.getByTestId(`pull-row-${id(n)}`)).toBeTruthy();
    expect(screen.queryByTestId(`pull-row-${id(2)}`)).toBeNull();
    // 不按类分组：一串 li，没有分组标题
    expect(screen.getByTestId('pull-results').querySelectorAll('ul').length).toBe(1);
    expect(screen.getByTestId(`pull-row-${id(1)}`).querySelector('mark')?.textContent).toBe('证件');
    expect(screen.getByTestId('pull-count').textContent).toBe('4 条');
    expect(screen.getByTestId('pull-ai').textContent).toBe('用 AI 按意思找 ›');
    expect(screen.queryByTestId('pull-empty')).toBeNull();
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(fx.logs).toContain('pull open todo via=touch');
    expect(fx.logs.some((l) => /^pull find todo len=2 n=4 ms=\d+$/.test(l))).toBe(true);
    expect(fx.logs.join(' ')).not.toContain('证件');
  });

  it('搜不到：居中提示“没有‘…’。”和同一个“用 AI 按意思找”，点了打开查找面板（openFind，from=pull）', () => {
    render(<Host tag="note" />);
    fireEvent.click(screen.getByText('open'));
    typeQ(' 发票 ');
    expect(screen.getByTestId('pull-count').textContent).toBe('0 条');
    expect(screen.getByTestId('pull-empty').textContent).toContain('没有“发票”。');
    fireEvent.click(screen.getByTestId('pull-ai'));
    expect(findOpenSnapshot()).toMatchObject({ q: '发票', from: 'pull', assist: null });
    expect(fx.logs).toContain('pull ai note n=0');
  });

  it('点一条：本页这一类交给页面（own：只读拦下、电脑版抽屉），别的类按类换页', () => {
    put('events', [{ id: id(6), ...live, title: '看牙医', date: '2026-11-20', start_time: '10:00', all_day: false, location: '', note: '' }]);
    put('todos', [{ id: id(7), ...live, title: '牙医挂号', note: '', project: '', due: null, done: false }]);
    const open = vi.fn();
    render(<Host tag="event" own={{ kind: 'event', open }} />);
    fireEvent.click(screen.getByText('open'));
    typeQ('牙医');
    fireEvent.click(screen.getByTestId(`pull-row-${id(6)}`));
    expect(open).toHaveBeenCalledWith(id(6));
    fireEvent.click(screen.getByTestId(`pull-row-${id(7)}`));
    expect(open).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe(`#/todo/${id(7)}`);
  });

  it('“×”只清空、搜索框留着；“取消”清空并收起', () => {
    render(<Host tag="note" />);
    fireEvent.click(screen.getByText('open'));
    typeQ('abc');
    fireEvent.click(screen.getByTestId('pull-clear'));
    expect(screen.getByTestId('pull-search')).toBeTruthy();
    // “×”清空后自己卸掉，焦点回到输入框（评审第 4 条）
    expect(document.activeElement).toBe(screen.getByTestId('pull-input'));
    expect(screen.queryByTestId('pull-ai')).toBeNull();
    typeQ('abc');
    fireEvent.click(screen.getByTestId('pull-cancel'));
    expect(screen.queryByTestId('pull-search')).toBeNull();
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    expect(fx.logs).toContain('pull close note');
  });

  it('从“搜索”打开：输入框自动聚焦；输入框里按 Esc 清空收起，焦点回到“搜索”', () => {
    render(<Host tag="note" />);
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(document.activeElement).toBe(screen.getByTestId('pull-input'));
    typeQ('abc');
    fireEvent.keyDown(screen.getByTestId('pull-input'), { key: 'Escape' });
    expect(screen.queryByTestId('pull-search')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('pull-key'));
    expect(fx.logs.slice(0, 2)).toEqual(['pull open note via=key', 'pull close note']);
  });

  it('改善报告 11-20 二-2：输入法组字时按 Esc 是撤掉候选，不收起（Safari keyCode 229、Chrome isComposing）；组字完再按才收起', () => {
    render(<Host tag="note" />);
    fireEvent.click(screen.getByTestId('pull-key'));
    typeQ('가');
    const input = screen.getByTestId('pull-input');
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27, isComposing: true });
    expect(screen.getByTestId('pull-search')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 });
    expect(screen.queryByTestId('pull-search')).toBeNull();
  });

  it('下拉打开的不抢焦点（手指还按着，弹键盘会顶乱页面）', () => {
    render(<Host tag="note" />);
    fireEvent.click(screen.getByText('open'));
    expect(document.activeElement).not.toBe(screen.getByTestId('pull-input'));
  });

  it('读屏：常驻的 role=status 停 SEM_DEBOUNCE_MS 才写条数，连着打字不一个字播一遍；清空后也清掉', () => {
    put('notes', [{ id: id(5), ...live, title: '牛奶', body: '', category_id: null, is_private: false, created_at: NOW }]);
    render(<Host tag="note" />);
    fireEvent.click(screen.getByText('open'));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    typeQ('x');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS / 2));
    typeQ('牛奶');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS / 2));
    expect(status.textContent).toBe('');
    // 看得见的条数照常跟手
    expect(screen.getByTestId('pull-count').textContent).toBe('1 条');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(status.textContent).toBe('1 条');
    expect(screen.getByRole('status')).toBe(status);
    typeQ('');
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(status.textContent).toBe('');
  });
});
