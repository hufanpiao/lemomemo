// 底栏页签的历史（负责人 11-18 推翻 R-372 ①：系统左边缘返回会抢在横滑切页前面）：点页签不让 <a href> 自己压历史，交给 navigateTab；
// 四个主页面之间一律原地换、一条都不压，没有 App 里的上一页。按着修饰键（新标签页打开）照浏览器默认，不拦
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canGoBack, useRoute } from '../../../../app/router.ts';
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
  window.history.pushState(null, '', '#/today'); // 截掉别的用例留下的“前进”历史
  base = window.history.length;
});
afterEach(cleanup);

describe('GlassBar：页签互切不压历史（负责人 11-18）', () => {
  it('今天 → 日历 → 待办 → 随手记 → 今天：一条都不压', async () => {
    render(<Bar />);
    for (const name of ['日历', '待办', '随手记']) {
      fireEvent.click(screen.getByRole('link', { name }));
      await flush();
    }
    expect(window.location.hash).toBe('#/notes');
    expect(window.history.length).toBe(base);
    fireEvent.click(screen.getByRole('link', { name: '今天' }));
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(window.history.length).toBe(base);
    expect(canGoBack()).toBe(false);
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

  it('手指点页签抬手就换页，不等 click（负责人 11-18“切页有点反应慢”）；跟着来的 click 不再换一次、不多压历史；手指挪动超过 10px 不算点', async () => {
    render(<Bar />);
    const touch = { pointerId: 7, button: 0, pointerType: 'touch', isPrimary: true } as const;
    const a = screen.getByRole('link', { name: '日历' });
    fireEvent.pointerDown(a, { ...touch, clientX: 100, clientY: 880 });
    fireEvent.pointerUp(a, { ...touch, clientX: 102, clientY: 881 });
    await vi.waitFor(() => expect(window.location.hash).toBe('#/calendar'));
    expect(window.history.length).toBe(base);
    expect(fireEvent.click(a), '跟着来的 click 照样拦默认跳转').toBe(false);
    await flush();
    expect(window.location.hash).toBe('#/calendar');
    expect(window.history.length, '没压历史').toBe(base);
    // 挪了 30px（滑过去的）：抬手不换，等 click（这里不发 click）
    const b = screen.getByRole('link', { name: '待办' });
    fireEvent.pointerDown(b, { ...touch, clientX: 200, clientY: 880 });
    fireEvent.pointerUp(b, { ...touch, clientX: 230, clientY: 880 });
    await flush();
    expect(window.location.hash).toBe('#/calendar');
    // 鼠标照旧走 click
    fireEvent.pointerDown(b, { pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true, clientX: 200, clientY: 880 });
    fireEvent.pointerUp(b, { pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true, clientX: 200, clientY: 880 });
    await flush();
    expect(window.location.hash).toBe('#/calendar');
    fireEvent.click(b);
    await vi.waitFor(() => expect(window.location.hash).toBe('#/todos'));
  });
});
