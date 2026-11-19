// 设置子页的进出（提醒接线代码审查 H1、M1，复审 L7；R-487 起按返回栈）：navigateSub 把上一层压进栈，backOrReplace 栈顶是上一层就退一步、否则原地换；
// 快速连点同一个入口只压一层。页面切换包在 View Transition 里，jsdom 没有 startViewTransition（直接同步画），L7 这里用替身把回调推迟到手动放行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canGoBack, goBack, stackOf } from '../router.ts';
import { backOrReplace, navigateSub } from '../router-sub.ts';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  window.history.replaceState(null, '', '#/today');
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe('backOrReplace：按栈顶回上一层', () => {
  it('今天 → 设置 → 提醒 → 未来 7 天，一层层返回：每次都是退一步，最后回到今天', async () => {
    await navigateSub('settings');
    await navigateSub('settings', 'remind');
    await navigateSub('settings', 'remind', 'upcoming');
    expect(stackOf()).toEqual(['#/today', '#/settings', '#/settings/remind']);
    backOrReplace('settings', 'remind');
    await flush();
    expect(window.location.hash).toBe('#/settings/remind');
    backOrReplace('settings');
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(stackOf()).toEqual(['#/today']);
  });

  it('直接打开三层页（栈空）：原地换成上一层，不跳层、不退出 App', async () => {
    window.history.replaceState(null, '', '#/settings/remind/dnd');
    const b = vi.spyOn(window.history, 'back');
    backOrReplace('settings', 'remind');
    await flush();
    expect(window.location.hash).toBe('#/settings/remind');
    backOrReplace('settings');
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(b).not.toHaveBeenCalled();
  });

  it('栈顶不是上一层（从别处跳进来的）：原地换成上一层，栈不动', async () => {
    window.history.replaceState({ lemoStack: ['#/todos'] }, '', '#/settings/remind');
    backOrReplace('settings');
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(stackOf()).toEqual(['#/todos']);
    expect(canGoBack()).toBe(true);
  });

  it('iOS 恢复、刷新后：栈在 history.state 里还在，照样退一步', async () => {
    window.history.replaceState({ lemoStack: ['#/today', '#/settings'] }, '', '#/settings/calendar');
    backOrReplace('settings');
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(stackOf()).toEqual(['#/today']);
  });

  it('全程不调 pushState、history.back', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const b = vi.spyOn(window.history, 'back');
    await navigateSub('settings', 'remind');
    backOrReplace('settings');
    goBack();
    await flush();
    expect(push).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});

describe('L7：快速连点同一个入口只压一层', () => {
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
    window.history.replaceState({ lemoStack: ['#/today'] }, '', '#/settings');
  });
  const release = (): void => queued.splice(0).forEach((f) => f());

  it('切换还没画完时点第二下：只压一层', async () => {
    const a = navigateSub('settings', 'remind');
    const b = navigateSub('settings', 'remind');
    release();
    await Promise.all([a, b]);
    expect(window.location.hash).toBe('#/settings/remind');
    expect(stackOf()).toEqual(['#/today', '#/settings']);
  });

  it('切换还没画完时连点两下返回：只退一层', async () => {
    window.history.replaceState({ lemoStack: ['#/today', '#/settings'] }, '', '#/settings/remind');
    goBack();
    goBack();
    release();
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(stackOf()).toEqual(['#/today']);
  });
});
