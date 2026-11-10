// 底栏页签按层级记历史（R-372 ①，负责人选“其他页左滑回今天”）：点页签不让 <a href> 自己压历史，交给 navigateTab；
// 今天 → 别的页签压一条，别的页签之间原地换，点“今天”退一步。按着修饰键（新标签页打开）照浏览器默认，不拦
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoadForTest, useRoute } from '../../../../app/router.ts';
import { GlassBar } from '../GlassBar.tsx';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** 跟着路由画的底栏（和 App 一样：active 跟当前页签） */
function Bar() {
  const r = useRoute();
  const name = r.name === 'calendar' || r.name === 'todos' || r.name === 'notes' ? r.name : 'today';
  return <GlassBar active={name} />;
}

let base = 0;
beforeEach(() => {
  resetLoadForTest();
  window.history.pushState(null, '', '#/today'); // 截掉别的用例留下的“前进”历史
  base = window.history.length;
});
afterEach(cleanup);

describe('GlassBar：页签按层级记历史（R-372）', () => {
  it('今天 → 日历 → 待办 → 随手记只压一条；点“今天”退一步回今天', async () => {
    render(<Bar />);
    for (const name of ['日历', '待办', '随手记']) {
      fireEvent.click(screen.getByRole('link', { name }));
      await flush();
    }
    expect(window.location.hash).toBe('#/notes');
    expect(window.history.length).toBe(base + 1);
    fireEvent.click(screen.getByRole('link', { name: '今天' }));
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(window.history.length).toBe(base + 1);
  });

  it('普通点击拦下链接默认跳转；按着修饰键点不拦（新标签页打开照常）', () => {
    render(<Bar />);
    const a = screen.getByRole('link', { name: '待办' });
    expect(fireEvent.click(a)).toBe(false); // 返回 false：默认行为被取消
    const b = screen.getByRole('link', { name: '日历' });
    b.addEventListener('click', (e) => e.preventDefault(), { once: true }); // 不真开新页
    const seen: boolean[] = [];
    b.addEventListener('click', (e) => seen.push(e.defaultPrevented), { once: true, capture: true });
    fireEvent.click(b, { metaKey: true });
    expect(seen).toEqual([false]);
  });
});
