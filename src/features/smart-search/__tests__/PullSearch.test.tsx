// 下拉搜索（R-437；R-447 S-B 原列表就地筛；ui/PullSearch.tsx、hooks/usePullFind.ts）：
// • 随手记、待办：打字当场算出命中交给 kit，页面原来的列表留着、只画命中的，命中的字加短下划线；框下一行条数；列表下面“用 AI 按意思找”，搜不到时居中提示
// • 待办：条数后面“全部未完成 / 含已完成”小下拉；靠子任务命中的也算
// • 日历（不就地筛）：本页藏起来、结果在搜索框下面列，点一条交给页面
// • 取消、Esc 清空收起、从“搜索本页”打开的自动聚焦、读屏的条数去抖、运行日志只记数不记字
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collection } from '../../../core/store.ts';
import { PullHit, PullSlot } from '../../../kit/components/PullSlot.tsx';
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

/** 页面的样子：一串行（id → 标题），就地筛时按 pull.shows 只画命中的；done 里的是已完成的待办，默认不画 */
function Host({ scope, rows = {}, done = [], onOpen }: { scope: PullScope; rows?: Record<string, string>; done?: string[]; onOpen?: (id: string) => void }) {
  const pull = usePullReveal('test');
  const [all, setAll] = useState(false);
  const inPlace = scope !== 'event';
  const shown = Object.keys(rows).filter((k) => pull.shows(k) && (!pull.searching || all || !done.includes(k)));
  return (
    <main ref={pull.ref}>
      <button type="button" onClick={() => pull.reveal('touch')}>open</button>
      <PullSlot
        pull={pull}
        keyLabel="搜索本页"
        inPlace={inPlace}
        search={(part) => (
          <PullSearch
            part={part}
            pull={pull}
            scope={scope}
            found={inPlace ? shown.length : undefined}
            done={scope === 'todo' ? { all, set: setAll } : undefined}
            onOpen={onOpen}
          />
        )}
      >
        <ul data-testid="page-list">
          {shown.map((k) => (
            <li key={k} data-testid={`li-${k}`}>
              <PullHit pull={pull} text={rows[k] ?? ''} />
            </li>
          ))}
        </ul>
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
  it('随手记：原列表留着、只画命中的，命中的字加下划线；条数、“用 AI 按意思找”；隐私记不出；日志只记字数和条数', () => {
    put('notes', [
      { id: id(1), ...live, title: '证件照', body: '护照和身份证都拍了', category_id: null, is_private: false, created_at: NOW },
      { id: id(2), ...live, title: '证件密码', body: '', category_id: null, is_private: true, created_at: NOW },
      { id: id(3), ...live, title: '牛奶', body: '', category_id: null, is_private: false, created_at: NOW },
    ]);
    render(<Host scope="note" rows={{ [id(1)]: '证件照', [id(3)]: '牛奶' }} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('pull-input').getAttribute('placeholder')).toBe('搜索随手记');
    expect(screen.queryByTestId('pull-count')).toBeNull();
    expect(screen.queryByTestId('pull-ai')).toBeNull();
    typeQ('证件');
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    expect(screen.queryByTestId('pull-results')).toBeNull();
    expect(screen.getByTestId(`li-${id(1)}`).querySelector('mark')?.textContent).toBe('证件');
    expect(screen.queryByTestId(`li-${id(3)}`)).toBeNull();
    expect(screen.getByTestId('pull-count').textContent).toBe('1 条');
    expect(screen.getByTestId('pull-ai').textContent).toBe('用 AI 按意思找 ›');
    expect(screen.queryByTestId('pull-empty')).toBeNull();
    act(() => void vi.advanceTimersByTime(SEM_DEBOUNCE_MS));
    expect(fx.logs).toContain('pull open test via=touch');
    expect(fx.logs.some((l) => /^pull find note len=2 n=1 shown=1 ms=\d+$/.test(l))).toBe(true);
    expect(fx.logs.join('\n')).not.toContain('证件');
  });

  it('搜不到：居中提示“随手记里没有‘…’。”和同一个“用 AI 按意思找”，点了打开查找面板（openFind，from=pull）', () => {
    render(<Host scope="note" rows={{ [id(3)]: '牛奶' }} />);
    fireEvent.click(screen.getByText('open'));
    typeQ(' 发票 ');
    expect(screen.queryByTestId(`li-${id(3)}`)).toBeNull();
    expect(screen.getByTestId('pull-count').textContent).toBe('0 条');
    expect(screen.getByTestId('pull-empty').textContent).toContain('随手记里没有“发票”。');
    fireEvent.click(screen.getByTestId('pull-ai'));
    expect(findOpenSnapshot()).toMatchObject({ q: '发票', from: 'pull', assist: null });
    expect(fx.logs).toContain('pull ai note n=0');
  });

  it('待办：默认只数未完成，小下拉换成“含已完成”；靠子任务命中的也算', () => {
    put('todos', [
      { id: id(3), ...live, title: '出差准备', note: '', project: '', due: null, done: false },
      { id: id(5), ...live, title: '护照续签', note: '', project: '', due: null, done: true },
    ]);
    put('todo_items', [{ id: id(4), ...live, todo_id: id(3), title: '带护照', done: false, sort: 1 }]);
    render(<Host scope="todo" rows={{ [id(3)]: '出差准备', [id(5)]: '护照续签' }} done={[id(5)]} />);
    fireEvent.click(screen.getByText('open'));
    typeQ('护照');
    expect(screen.getByTestId(`li-${id(3)}`)).toBeTruthy();
    expect(screen.queryByTestId(`li-${id(5)}`)).toBeNull();
    expect(screen.getByTestId('pull-count').textContent).toContain('1 未完成');
    fireEvent.change(screen.getByTestId('pull-scope'), { target: { value: 'all' } });
    expect(screen.getByTestId(`li-${id(5)}`)).toBeTruthy();
    expect(screen.getByTestId('pull-count').textContent).toContain('2 条');
    expect(screen.queryByTestId('pull-empty')).toBeNull();
  });

  it('日历（不就地筛）：本页藏起来，结果在搜索框下面列，命中的字加同一道下划线；点一条交给页面', () => {
    put('events', [{ id: id(6), ...live, title: '看牙医', date: '2026-11-20', start_time: '10:00', all_day: false, location: '', note: '' }]);
    const onOpen = vi.fn();
    render(<Host scope="event" onOpen={onOpen} />);
    fireEvent.click(screen.getByText('open'));
    typeQ('牙医');
    expect(screen.getByTestId('pull-keep').hidden).toBe(true);
    expect(screen.getByTestId('pull-count').textContent).toBe('1 条');
    const row = screen.getByTestId(`pull-row-${id(6)}`);
    expect(row.querySelector('mark')?.textContent).toBe('牙医');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(id(6));
    typeQ('发票');
    expect(screen.getByTestId('pull-empty').textContent).toContain('日程里没有“发票”。');
  });

  it('“×”只清空、搜索框留着；“取消”清空并收起', () => {
    render(<Host scope="note" />);
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
    expect(fx.logs).toContain('pull close test');
  });

  it('从“搜索本页”打开：输入框自动聚焦；输入框里按 Esc 清空收起，焦点回到“搜索本页”', () => {
    render(<Host scope="note" />);
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(document.activeElement).toBe(screen.getByTestId('pull-input'));
    typeQ('abc');
    fireEvent.keyDown(screen.getByTestId('pull-input'), { key: 'Escape' });
    expect(screen.queryByTestId('pull-search')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('pull-key'));
    expect(fx.logs.slice(0, 2)).toEqual(['pull open test via=key', 'pull close test']);
  });

  it('改善报告 11-20 二-2：输入法组字时按 Esc 是撤掉候选，不收起（Safari keyCode 229、Chrome isComposing）；组字完再按才收起', () => {
    render(<Host scope="note" />);
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
    render(<Host scope="note" />);
    fireEvent.click(screen.getByText('open'));
    expect(document.activeElement).not.toBe(screen.getByTestId('pull-input'));
  });

  it('读屏：常驻的 role=status 停 SEM_DEBOUNCE_MS 才写条数，连着打字不一个字播一遍；清空后也清掉', () => {
    put('notes', [{ id: id(5), ...live, title: '牛奶', body: '', category_id: null, is_private: false, created_at: NOW }]);
    render(<Host scope="note" rows={{ [id(5)]: '牛奶' }} />);
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
