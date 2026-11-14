// 四个页签互切的淡入（负责人 11-06 方案 B）：不起 View Transition，新页 main 做一次 opacity 0→1；连点取消上一次；减少动态效果时不动；
// 换页后 FADE_GUARD_MS 内吞掉 main 里的点按（代码审查方案 B M8）；等分包时走了整页过渡、同页内切换就停掉（M9）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FADE_GUARD_MS, FADE_SKIP_MS, FADE_WAIT_MS, cancelFade, fadeSwap, transition } from '../index.ts';
import { dur, ease } from '../tokens.ts';

/** 换成只有一个 main 的页面（name 为 null 时清空：新页分包还没到） */
const setPage = (name: string | null): void => {
  if (name === null) {
    document.body.replaceChildren();
    return;
  }
  const m = document.createElement('main');
  m.dataset.feature = name;
  document.body.replaceChildren(m);
};

interface FakeAnim {
  el: Element;
  currentTime: number | null;
  frames: Keyframe[];
  opts: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
  finish(): void;
}
let anims: FakeAnim[] = [];

beforeEach(() => {
  anims = [];
  Element.prototype.animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    let done = (): void => undefined;
    let fail = (_e: unknown): void => undefined;
    const finished = new Promise<void>((res, rej) => {
      done = res;
      fail = rej;
    });
    const a: FakeAnim = { el: this, currentTime: 0, frames, opts, cancel: vi.fn(() => fail(new Error('AbortError'))), finished, finish: () => done() };
    anims.push(a);
    return a as unknown as Animation;
  } as unknown as Element['animate'];
  setPage(null);
  document.documentElement.removeAttribute('data-rm');
});

afterEach(() => {
  cancelFade();
  vi.useRealTimers();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

const pickMain = (): Element | null => document.querySelector('main');

describe('fadeSwap', () => {
  it('同步换页、不起 View Transition；新页 main 用 --dur-ui、--ease-out 从 0 淡到 1，跳过第一帧（不画整页透明的一帧）', async () => {
    const vt = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = vt;
    const update = vi.fn(() => {
      setPage('todos');
    });
    const p = fadeSwap(update, pickMain);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vt).not.toHaveBeenCalled();
    expect(anims).toHaveLength(1);
    expect(anims[0]?.el).toBe(document.querySelector('main'));
    expect(anims[0]?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(anims[0]?.opts.duration).toBe(dur.ui * 1000);
    expect(anims[0]?.currentTime, '跳过 opacity 0 的第一帧').toBe(FADE_SKIP_MS);
    expect(anims[0]?.opts.easing).toBe(`cubic-bezier(${ease.out.join(',')})`);
    anims[0]?.finish();
    await expect(p).resolves.toBeUndefined();
  });

  it('连点：下一次先 cancel() 上一次还没播完的淡入', async () => {
    const swap = (name: string) => () => {
      setPage(name);
    };
    const p1 = fadeSwap(swap('today'), pickMain);
    const p2 = fadeSwap(swap('calendar'), pickMain);
    expect(anims[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(anims).toHaveLength(2);
    await expect(p1).resolves.toBeUndefined();
    anims[1]?.finish();
    await expect(p2).resolves.toBeUndefined();
  });

  it('减少动态效果（data-rm="1"）：只换页，不动', async () => {
    document.documentElement.setAttribute('data-rm', '1');
    const update = vi.fn(() => {
      setPage('x');
    });
    await fadeSwap(update, pickMain);
    expect(update).toHaveBeenCalledTimes(1);
    expect(anims).toHaveLength(0);
  });

  it('新页分包还没到：等 main 出来再淡入；FADE_WAIT_MS 内一直没出来就不淡了', async () => {
    const p = fadeSwap(() => undefined, pickMain);
    expect(anims).toHaveLength(0);
    document.body.append(document.createElement('main'));
    await p;
    expect(anims).toHaveLength(1);

    vi.useFakeTimers();
    const q = fadeSwap(() => {
      setPage(null);
    }, pickMain);
    vi.advanceTimersByTime(FADE_WAIT_MS);
    await expect(q).resolves.toBeUndefined();
    expect(anims).toHaveLength(1);
  });

  it('新页分包没到、旧页的 main 还留着：不给旧页淡入，等新页的 main 换上来再淡', async () => {
    setPage('today');
    const old = document.querySelector('main');
    const p = fadeSwap(() => undefined, pickMain);
    expect(anims).toHaveLength(0);
    setPage('todos');
    await p;
    expect(anims).toHaveLength(1);
    expect(anims[0]?.el).not.toBe(old);
    expect(anims[0]?.el.getAttribute('data-feature')).toBe('todos');
  });

  it('还在等分包时又点了别的页签：上一次不再等（不会晚到时再淡一次）', async () => {
    const p1 = fadeSwap(() => undefined, pickMain);
    const p2 = fadeSwap(() => {
      setPage('x');
    }, pickMain);
    await p1;
    expect(anims).toHaveLength(1);
    anims[0]?.finish();
    await p2;
    document.body.append(document.createElement('main'));
    await Promise.resolve();
    expect(anims).toHaveLength(1);
  });
});

describe('换页后吞点按（代码审查方案 B M8）', () => {
  /** 换成带一个按钮的新页，外加 main 外面的底栏按钮；返回两个按钮的点按计数 */
  const pageWithButtons = () => {
    const main = document.createElement('main');
    const del = document.createElement('button');
    main.append(del);
    const nav = document.createElement('nav');
    const tab = document.createElement('button');
    nav.append(tab);
    const onDel = vi.fn();
    const onTab = vi.fn();
    del.addEventListener('click', onDel);
    del.addEventListener('pointerdown', onDel);
    tab.addEventListener('click', onTab);
    return { swap: () => document.body.replaceChildren(main, nav), del, tab, onDel, onTab };
  };
  const down = (el: Element): boolean => el.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  /** 手指、鼠标点出来的 click（detail 1）；键盘的 click 前面有 keydown，守卫不吞（R-420 审查第 13 条） */
  const tapClick = (el: Element, detail = 1): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));

  it('窗口内：main 里的 pointerdown、click 都吞（不冒泡、preventDefault）；底栏照常能点', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(10);
    expect(down(p.del)).toBe(false);
    tapClick(p.del);
    expect(p.onDel).not.toHaveBeenCalled();
    p.tab.click();
    expect(p.onTab).toHaveBeenCalledTimes(1);
  });

  it('窗口外照常；按下在窗口里、松开（click）晚到窗口外的那一下也吞', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(FADE_GUARD_MS - 20);
    down(p.del);
    vi.advanceTimersByTime(60);
    tapClick(p.del);
    expect(p.onDel).not.toHaveBeenCalled();
    tapClick(p.del); // 下一次点按照常
    expect(p.onDel).toHaveBeenCalledTimes(1);
  });

  // 代码审查 S12：换页后马上往上划，按下被吞、变成滚动没有 click；1 秒内下一次正常点按的 click 不能当成晚到的那一下吞掉
  it('S12：被吞的按下没等到 click，窗口外又按下：这一次的 click 是真点', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(10);
    expect(down(p.del)).toBe(false); // 往上划的那一下：按下吞了，后面没有 click
    vi.advanceTimersByTime(300);
    expect(down(p.del)).toBe(true);
    tapClick(p.del);
    expect(p.onDel).toHaveBeenCalledTimes(2); // pointerdown、click 都到了
  });

  it('S12：被吞的按下变成滚动（pointercancel）：之后的 click 照常', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(10);
    down(p.del);
    p.del.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    vi.advanceTimersByTime(300);
    tapClick(p.del);
    expect(p.onDel).toHaveBeenCalledTimes(1);
  });

  it('窗口过了（200 ms）点 main 里的按钮是真点', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(200);
    expect(down(p.del)).toBe(true);
    tapClick(p.del);
    expect(p.onDel).toHaveBeenCalledTimes(2);
  });

  it('窗口内键盘的 click（先 keydown：焦点在按钮上按回车）照常，不当成手指点在旧画面上', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    vi.advanceTimersByTime(10);
    p.del.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tapClick(p.del, 0)).toBe(true);
    expect(p.onDel).toHaveBeenCalledTimes(1);
  });

  it('吞掉的那一下用 stopImmediatePropagation：document 上后挂的捕获监听也收不到', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    const late = vi.fn();
    document.addEventListener('click', late, true);
    document.addEventListener('pointerdown', late, true);
    vi.advanceTimersByTime(10);
    down(p.del);
    tapClick(p.del);
    document.removeEventListener('click', late, true);
    document.removeEventListener('pointerdown', late, true);
    expect(late).not.toHaveBeenCalled();
  });

  it('减少动态效果时也吞（旧页一样是瞬间没的）', () => {
    document.documentElement.setAttribute('data-rm', '1');
    const p = pageWithButtons();
    void fadeSwap(p.swap, pickMain);
    tapClick(p.del);
    expect(p.onDel).not.toHaveBeenCalled();
  });

  it('摘监听：窗口过了、下一次换页、cancelFade 都摘掉，document 上不留', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const add = vi.spyOn(document, 'addEventListener');
    const rm = vi.spyOn(document, 'removeEventListener');
    const live = (): number => add.mock.calls.filter((c) => c[2] === true).length - rm.mock.calls.filter((c) => c[2] === true).length;
    void fadeSwap(() => setPage('a'), pickMain);
    expect(live()).toBe(3); // pointerdown、click、keydown（晚到那一下和 S12 的 pointercancel 在 swallowNextClick 里、挂在 window 上，见 swallow-click.test.ts）
    void fadeSwap(() => setPage('b'), pickMain);
    expect(live()).toBe(3); // 上一次的摘了，这一次的挂上
    vi.advanceTimersByTime(FADE_GUARD_MS + 1);
    expect(live()).toBe(0);
    void fadeSwap(() => setPage('c'), pickMain);
    cancelFade();
    expect(live()).toBe(0);
    add.mockRestore();
    rm.mockRestore();
  });
});

describe('等分包时走了别的导航（代码审查方案 B M9）', () => {
  it('等的时候走了 transition()：View Transition 换上来的页不再淡入', async () => {
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    };
    setPage('today');
    void fadeSwap(() => undefined, pickMain); // 分包没到，旧页还在
    await transition(() => setPage('edit'));
    await Promise.resolve();
    expect(anims).toHaveLength(0);
    setPage('todos'); // 分包这时才到也不淡
    await Promise.resolve();
    expect(anims).toHaveLength(0);
  });

  it('等的时候同页内切换（cancelFade(false)）：后来换上来的不淡；正在播的淡入不打断', async () => {
    void fadeSwap(() => setPage('a'), pickMain);
    expect(anims).toHaveLength(1);
    cancelFade(false);
    expect(anims[0]?.cancel).not.toHaveBeenCalled();
    setPage('today');
    void fadeSwap(() => undefined, pickMain);
    cancelFade(false);
    setPage('cal');
    await Promise.resolve();
    expect(anims).toHaveLength(1);
  });
});
