// #/calendar 和 #/cal/... 是同一个页面（B2 FA-3 代码审查 M7）：互相跳时 App 不重新挂载月历页，焦点留在刚点的按钮上
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { featureRoutes } from '../features.ts';

// 整个 App 挂载、页面懒加载：全量三个时区同时跑、机器忙时会拖过默认 5 秒（c8b5596 的 CI unit 就是这样超时的），
// 这个文件单独放宽到 15 秒，等页面出现的上限 10 秒；单跑仍在 3 秒内
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('月历两条路由同一个页面', () => {
  it('登记表：cal 写着 samePageAs: calendar', () => {
    expect(featureRoutes.find((r) => r.name === 'cal')?.samePageAs).toBe('calendar');
  });

  it('#/calendar 点“下个月”到 #/cal/month/...：同一个页面元素，焦点还在“下个月”按钮上', async () => {
    window.history.replaceState(null, '', '/app/#/calendar');
    render(<App />);
    const page = await screen.findByTestId('calendar-page', {}, { timeout: 10_000 });
    const next = screen.getByTestId('cal-next');
    next.focus();
    await act(async () => {
      fireEvent.click(next);
    });
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/cal\/month\/\d{4}-\d{2}$/));
    expect(screen.getByTestId('calendar-page')).toBe(page);
    expect(page.isConnected).toBe(true);
    expect(document.activeElement).toBe(next);
  });
});

// 代码复审 R2（架构 5.12 页内切换不用 View Transition）：浏览器在同一页里前进 / 后退也直接画
describe('同一页里浏览器前进 / 后退不播整页动画', () => {
  const doc = document as unknown as { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  afterEach(() => {
    delete doc.startViewTransition;
  });

  async function back(from: string, to: string) {
    const spy = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    doc.startViewTransition = spy;
    window.history.replaceState(null, '', `/app/${to}`);
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: `http://x/app/${from}`, newURL: `http://x/app/${to}` }));
    });
    return spy;
  }

  it('#/cal/month/2026-11 后退到 #/cal/month/2026-10、#/cal/... 回到 #/calendar：不起 View Transition', async () => {
    window.history.replaceState(null, '', '/app/#/cal/month/2026-11');
    render(<App />);
    await screen.findByTestId('calendar-page', {}, { timeout: 10_000 });
    expect((await back('#/cal/month/2026-11', '#/cal/month/2026-10')).mock.calls).toHaveLength(0);
    expect((await back('#/cal/month/2026-10', '#/calendar')).mock.calls).toHaveLength(0);
    expect(window.location.hash).toBe('#/calendar');
  });

  it('换页照常起动画：#/today → #/calendar，以及没登记 samePageAs 的同名路由 #/event/a → #/event/b', async () => {
    window.history.replaceState(null, '', '/app/#/today');
    render(<App />);
    expect((await back('#/today', '#/calendar')).mock.calls).toHaveLength(1);
    expect((await back('#/event/a', '#/event/b')).mock.calls).toHaveLength(1);
  });
});
