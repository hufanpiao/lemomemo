// onAuthUser 预加载 supabase-js 先等首屏画完（B2 FA-6 ①；推迟启动代码审查 M2）：入口 arm 了首屏判断、还没算画完时，
// 等多久都不调 getSupabase（只等浏览器空闲不够：页面分包还在下载时浏览器就已经“空闲”了）；算画完（入口在页面出来再过一帧时 markAppPainted）以后才调
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armAppPaint, markAppPainted, resetRootPaintForTest } from '../root-paint.ts';

const getSupabase = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('no env'))));
vi.mock('../supabase/client.ts', () => ({
  getSupabase,
  onClientReady: () => () => undefined,
}));

const { onAuthUser } = await import('../session.ts');

beforeEach(() => {
  resetRootPaintForTest();
  getSupabase.mockClear();
});
afterEach(() => resetRootPaintForTest());

describe('onAuthUser 等首屏画完', () => {
  it('首屏画完之前不调 getSupabase；算画完、浏览器空闲以后才调', async () => {
    armAppPaint();
    const off = onAuthUser(() => undefined);
    // 浏览器早就“空闲”了（whenIdle 的回调有机会跑好几轮）
    await new Promise((r) => setTimeout(r, 300));
    expect(getSupabase).not.toHaveBeenCalled();
    markAppPainted();
    await vi.waitFor(() => expect(getSupabase).toHaveBeenCalledTimes(1));
    off();
  });

  it('画完之前就取消了：画完以后也不调', async () => {
    armAppPaint();
    const off = onAuthUser(() => undefined);
    off();
    markAppPainted();
    await new Promise((r) => setTimeout(r, 300));
    expect(getSupabase).not.toHaveBeenCalled();
  });
});
