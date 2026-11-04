// onAuthUser 预加载 supabase-js 先等首屏画完（B2 FA-6 ①；推迟启动代码审查 M2）：入口挂了 watchAppPainted、页面还没画出来时，
// 等多久都不调 getSupabase（只等浏览器空闲不够：页面分包还在下载时浏览器就已经“空闲”了）；功能页出现、那一帧跑完以后才调
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppPaintedForTest, watchAppPainted, type FrameScheduler } from '../first-paint.ts';

const getSupabase = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('no env'))));
vi.mock('../supabase/client.ts', () => ({
  getSupabase,
  onClientReady: () => () => undefined,
}));

const { onAuthUser } = await import('../session.ts');

let root: HTMLElement;
beforeEach(() => {
  resetAppPaintedForTest();
  getSupabase.mockClear();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  resetAppPaintedForTest();
});

describe('onAuthUser 等首屏画完', () => {
  it('首屏画完之前不调 getSupabase；功能页出现、那一帧跑完、浏览器空闲以后才调', async () => {
    const q: (() => void)[] = [];
    const next: FrameScheduler = (fn) => {
      q.push(fn);
      return () => undefined;
    };
    watchAppPainted(root, next);
    const off = onAuthUser(() => undefined);
    // 浏览器早就“空闲”了（whenIdle 的回调有机会跑好几轮）
    await new Promise((r) => setTimeout(r, 300));
    expect(getSupabase).not.toHaveBeenCalled();
    const page = document.createElement('main');
    page.dataset['feature'] = 'today';
    root.appendChild(page);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.length).toBe(1);
    expect(getSupabase).not.toHaveBeenCalled();
    for (const f of q.splice(0)) f();
    await vi.waitFor(() => expect(getSupabase).toHaveBeenCalledTimes(1));
    off();
  });

  it('画完之前就取消了：画完以后也不调', async () => {
    const q: (() => void)[] = [];
    watchAppPainted(root, (fn) => {
      q.push(fn);
      return () => undefined;
    });
    const off = onAuthUser(() => undefined);
    off();
    const page = document.createElement('main');
    page.dataset['feature'] = 'today';
    root.appendChild(page);
    await new Promise((r) => setTimeout(r, 0));
    for (const f of q.splice(0)) f();
    await new Promise((r) => setTimeout(r, 300));
    expect(getSupabase).not.toHaveBeenCalled();
  });
});
