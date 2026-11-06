// 设置子页的历史记号（提醒接线代码复审第二轮 N1、L7）：navigateSub 记的是上一层的地址，backOrReplace 退之前对一下上一条现在是不是它；
// 快速连点同一个入口只压一条。页面切换包在 View Transition 里，jsdom 没有 startViewTransition（直接同步画），L7 这里用替身把回调推迟到手动放行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK_FIX_MS, backOrReplace, isSubEntry, navigateSub, replaceRoute, useRoute } from '../router.ts';
import { renderHook } from '@testing-library/react';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** history.back 以后等 popstate、hashchange 都派完 */
async function back(): Promise<void> {
  window.history.back();
  await vi.waitFor(() => new Promise((r) => setTimeout(r, 10)));
  await flush();
}
async function forward(): Promise<void> {
  window.history.forward();
  await vi.waitFor(() => new Promise((r) => setTimeout(r, 10)));
  await flush();
}

beforeEach(() => {
  window.history.replaceState(null, '', '#/today');
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe('N1：上一条后来被换成了别的页，返回不跳层', () => {
  it('直接打开二级页 → 进三层页 → 侧滑 → “‹ 设置”原地换成首页 → 前进 → 点返回：回到二级页，不叠历史', async () => {
    const r = renderHook(() => useRoute());
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings/remind'); // 直接打开：没有记号
    await navigateSub('settings', 'remind', 'upcoming');
    expect(isSubEntry()).toBe(true);
    await back();
    expect(window.location.hash).toBe('#/settings/remind');
    backOrReplace('settings'); // 没有记号：原地换成首页
    await flush();
    expect(window.location.hash).toBe('#/settings');
    await forward();
    expect(window.location.hash).toBe('#/settings/remind/upcoming');
    // 记号写着上一层是 #/settings/remind，可上一条现在是 #/settings：不算点进来的
    expect(isSubEntry()).toBe(false);
    const push = vi.spyOn(window.history, 'pushState');
    backOrReplace('settings', 'remind');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    await flush();
    expect(push).not.toHaveBeenCalled();
    expect(r.result.current).toEqual({ name: 'settings', params: ['remind'] });
    // 退了一步（不是原地换）：再退一步就是今天，中间没有叠出来的“设置”
    expect(window.history.state).toEqual({ lemoDepth: 1 });
    await back();
    expect(window.location.hash).toBe('#/today');
    r.unmount();
  });

  it('上一条没被换过：照旧是点进来的，退一步', async () => {
    const r = renderHook(() => useRoute());
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
    await navigateSub('settings', 'remind');
    await navigateSub('settings', 'remind', 'upcoming');
    expect(isSubEntry()).toBe(true);
    await back();
    expect(isSubEntry()).toBe(true);
    await forward();
    expect(isSubEntry()).toBe(true);
    const replace = vi.spyOn(window.history, 'replaceState');
    backOrReplace('settings', 'remind');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    await flush();
    expect(replace).not.toHaveBeenCalled();
    r.unmount();
  });

  it('没有记号（直接打开）：原地换成上一层，不退', async () => {
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings/remind/dnd');
    const b = vi.spyOn(window.history, 'back');
    backOrReplace('settings', 'remind');
    await flush();
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/settings/remind');
  });

  it('旧版记号 true（没记地址）照旧当点进来的', () => {
    window.history.pushState({ lemoDepth: 2, lemoSub: true }, '', '#/settings/remind');
    expect(isSubEntry()).toBe(true);
  });

  it('不知道上一条是什么（刷新以后没记到）：信记号', async () => {
    window.history.pushState({ lemoDepth: 7, lemoSub: '#/settings' }, '', '#/settings/remind');
    expect(isSubEntry()).toBe(true);
    await replaceRoute('settings', 'calendar'); // 换掉的这条不带记号
    expect(isSubEntry()).toBe(false);
  });
});

describe('审查 S-L1、S-L2：popstate 修正', () => {
  it('S-L1 刷新以后（不知道上一条现在是什么）：上一条其实被换成了首页，返回仍回到二级页、不跳层', async () => {
    // 深度用别的用例没用过的数，模拟刷新后 entryAt 里没有这两层
    window.history.pushState({ lemoDepth: 41 }, '', '#/settings'); // 原来的二级页被换成了首页
    window.history.pushState({ lemoDepth: 42, lemoSub: '#/settings/remind' }, '', '#/settings/remind/upcoming');
    expect(isSubEntry()).toBe(true); // 只信记号
    backOrReplace('settings', 'remind');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    expect(window.history.state).toEqual({ lemoDepth: 41 });
  });

  it('S-L2 修正只认这一次后退：退到的不是退之前减 1 的那一层（不相干的后退）就不动', async () => {
    window.history.pushState({ lemoDepth: 51 }, '', '#/todos');
    window.history.pushState({ lemoDepth: 52 }, '', '#/settings/calendar');
    window.history.pushState({ lemoDepth: 53, lemoSub: '#/settings' }, '', '#/settings/remind');
    const b = vi.spyOn(window.history, 'back').mockImplementation(() => undefined); // 这一次后退没发生
    backOrReplace('settings');
    expect(b).toHaveBeenCalledTimes(1);
    b.mockRestore();
    window.history.go(-2); // 不相干的后退，退到深度 51
    await vi.waitFor(() => expect(window.location.hash).toBe('#/todos'));
    await flush();
    expect(window.history.state).toEqual({ lemoDepth: 51 });
  });

  it('S-L2 后退一直没派出 popstate：约 1 秒后修正自己摘掉，之后再退到那一层也不会被换掉', async () => {
    window.history.pushState({ lemoDepth: 61 }, '', '#/settings/calendar');
    window.history.pushState({ lemoDepth: 62, lemoSub: '#/settings' }, '', '#/settings/remind');
    const b = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const removed = vi.spyOn(window, 'removeEventListener');
    backOrReplace('settings');
    b.mockRestore();
    await new Promise((r) => setTimeout(r, BACK_FIX_MS + 50));
    expect(removed.mock.calls.some(([type]) => type === 'popstate')).toBe(true);
    window.history.back(); // 1 秒以后真的退到深度 61
    await vi.waitFor(() => expect(window.location.hash).toBe('#/settings/calendar'));
    await flush();
    expect(window.location.hash).toBe('#/settings/calendar');
  });
});

describe('L7：快速连点同一个入口只压一条', () => {
  let queued: (() => void)[] = [];
  beforeEach(() => {
    queued = [];
    // 替身：回调先排着，release() 才执行（真浏览器里要等截完旧画面）
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      queued.push(() => {
        cb();
        done();
      });
      return { finished };
    };
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
  });
  const release = (): void => queued.splice(0).forEach((f) => f());

  it('切换还没画完时点第二下：返回同一次的 Promise，只压一条', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const a = navigateSub('settings', 'remind');
    const b = navigateSub('settings', 'remind');
    expect(b).toBe(a);
    expect(queued).toHaveLength(1);
    release();
    await a;
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/settings/remind');
    // 画完以后再点：已经在这一页，不压
    await navigateSub('settings', 'remind');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('排着的时候地址已经被别处换成目标：回调里再看一次，不压', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const a = navigateSub('settings', 'calendar');
    window.history.replaceState({ lemoDepth: 1 }, '', '#/settings/calendar');
    release();
    await a;
    expect(push).not.toHaveBeenCalled();
  });
});
