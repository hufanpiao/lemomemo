// 四个页签互切（负责人 11-06 方案 B 不起 View Transition；11-18“底部导航切页动画直接套用日历的切页动画，做成一模一样的动效”）：
// 和日历翻月同一份原地模糊淡换（blur-swap.ts）——新页从模糊 4px、透明到清晰，旧页快照模糊到 4px、前 2/3 淡没，880ms、--ease-out；连点取消上一次；减少动态效果时不动；
// 换页后 FADE_GUARD_MS 内吞掉 main 里的点按（代码审查方案 B M8）；等分包时走了整页过渡、同页内切换就停掉（M9）。
// 11-18 独立评审后整块重写（src/motion/page-swap.ts）：平移换成像素（H1）、快照先藏后显（M2）、连点快照从上一页此刻的样子起（M1）、
// 长成放完先收打字条再还原层级（H2）
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blurSwapIn, blurSwapOut, blurSwapTiming } from '../blur-swap.ts';
import { FADE_GUARD_MS, FADE_WAIT_MS, GROW_HOLD, cancelFade, fadeSwap, growSwap as growFromCard, loadPageSwap, transition } from '../index.ts';
// 长成的手感直接测实现（卡的位置、圆角当参数给）；门面从卡元素量的那一步见下面“门面从卡量”
import { growSwap } from '../page-swap.ts';
import { bezierCss, dur, ease } from '../tokens.ts';

/** 换页（像 React：只换掉自己的 main，别人放进来的节点——快照、打字条——不动）；name 为 null 时只拿掉 main：新页分包还没到 */
const setPage = (name: string | null): void => {
  for (const m of document.querySelectorAll('main')) m.remove();
  if (name === null) return;
  const m = document.createElement('main');
  m.dataset.feature = name;
  document.body.append(m);
};
/** 带 id 的元素 */
const el = (tag: string, id: string, ...kids: Element[]): HTMLElement => {
  const e = Object.assign(document.createElement(tag), { id });
  e.append(...kids);
  return e;
};
/** 等 MutationObserver 回调跑完 */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
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

// 换页动画实现首屏画完以后才下载（index.ts 的 loadPageSwap）：这里测的是到了以后的样子，先等它到
beforeAll(() => loadPageSwap());

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
  // “显示着”的口径：jsdom 里由 tests/fakes/jsdom-layout-setup.ts 补（同浏览器里 Suspense 藏旧页的样子）
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-rm');
});

afterEach(() => {
  cancelFade();
  vi.useRealTimers();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});


describe('fadeSwap', () => {
  it('同步换页、不起 View Transition；新页 main 和日历翻月同一份关键帧（模糊 4px、透明 → 清晰），880ms、--ease-out，不平移', async () => {
    const vt = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = vt;
    const update = vi.fn(() => {
      setPage('todos');
    });
    const p = fadeSwap(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vt).not.toHaveBeenCalled();
    expect(anims).toHaveLength(1);
    expect(anims[0]?.el).toBe(document.querySelector('main'));
    expect(anims[0]?.frames).toEqual(blurSwapIn(false));
    expect(anims[0]?.frames).toEqual([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0px)' }]);
    expect(anims[0]?.opts).toEqual(blurSwapTiming(false));
    expect(anims[0]?.opts.duration).toBe(dur.ui * 1000 * 4);
    expect(anims[0]?.opts.easing).toBe(bezierCss(ease.out));
    expect(anims[0]?.currentTime, '和日历一样从头播').toBe(0);
    anims[0]?.finish();
    await expect(p).resolves.toBeUndefined();
  });

  it('连点：下一次先 cancel() 上一次还没播完的淡入', async () => {
    const swap = (name: string) => () => {
      setPage(name);
    };
    const p1 = fadeSwap(swap('today'));
    const p2 = fadeSwap(swap('calendar'));
    expect(anims[0]?.cancel).toHaveBeenCalledTimes(1);
    // 第二次有旧页（today）可拷：新页 main 一个、旧页快照一个
    expect(anims).toHaveLength(3);
    expect(anims[1]?.el.getAttribute('data-feature')).toBe('calendar');
    await expect(p1).resolves.toBeUndefined();
    anims[1]?.finish();
    await expect(p2).resolves.toBeUndefined();
  });

  it('连点：和日历一样新页从头播；快照从上一页此刻的透明度起，不先跳回全亮（M1）', () => {
    fadeSwap(() => setPage('today'));
    const today = document.querySelector('main') as HTMLElement;
    today.style.opacity = '0.6';
    fadeSwap(() => setPage('notes'));
    expect(anims[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(anims[1]?.frames).toEqual(blurSwapIn(false));
    expect(anims[1]?.opts.duration).toBe(blurSwapTiming(false).duration);
    expect(anims[2]?.frames).toEqual(blurSwapOut(false, 0, 0.6));
  });

  it('main 里有 position: fixed 的元素（随手记贴底输入行）：淡入和模糊只加在不含 fixed 的子树上（filter 会让 fixed 后代改按祖先定位），fixed 的自己只淡入', () => {
    const inrow = el('div', 'inrow');
    inrow.style.position = 'fixed';
    fadeSwap(() => document.body.replaceChildren(el('main', 'm', el('header', 'h'), el('div', 'wrap', el('ul', 'list'), el('div', 'dock', inrow, el('span', 'tip'))))));
    expect(anims.map((a) => a.el.id)).toEqual(['h', 'list', 'tip', 'inrow']);
    for (const a of anims.slice(0, 3)) expect(a.frames).toEqual(blurSwapIn(false));
    expect(anims[3]?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    cancelFade();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  describe('右上角头像（data-swap-pin；负责人 11-18“头像怎么也还是会消失”）', () => {
    /** 一页：标题行里左边标题、右边头像，下面一块内容；头像有大小（jsdom 不排版，按打了属性的算 44 宽） */
    const page = (name: string): HTMLElement => {
      const me = el('a', `me-${name}`);
      me.setAttribute('data-swap-pin', '');
      const m = el('main', `m-${name}`, el('div', `head-${name}`, el('h1', `t-${name}`), me), el('section', `body-${name}`));
      m.dataset.feature = name;
      return m;
    };
    const realBox = Element.prototype.getBoundingClientRect;
    beforeEach(() => {
      Element.prototype.getBoundingClientRect = function (this: Element) {
        return this.hasAttribute('data-swap-pin') && this.isConnected ? new DOMRect(370, 16, 44, 44) : new DOMRect();
      };
    });
    afterEach(() => {
      Element.prototype.getBoundingClientRect = realBox;
    });
    const pinBox = (): Element | null => document.querySelector('[data-tab-pin]');

    it('新页的头像是真元素、从头到尾全亮：它和它的祖先都不加动画、不加内联透明度；淡入只加在不含它的子树上', () => {
      document.body.replaceChildren(page('today'));
      fadeSwap(() => document.querySelector('main')?.replaceWith(page('todos')));
      const moved = anims.filter((a) => !a.el.closest('[data-tab-ghost]') && !a.el.hasAttribute('data-tab-ghost')).map((a) => a.el.id);
      expect(moved).toEqual(['t-todos', 'body-todos']);
      const me = document.getElementById('me-todos') as HTMLElement;
      expect(me.style.opacity).toBe('');
      expect(anims.some((a) => a.el === me || a.el.contains(me))).toBe(false);
    });

    it('钉住的副本只管新页出来之前那一段：新页出来、有自己的头像，副本当场拿掉', async () => {
      document.body.replaceChildren(page('today'));
      fadeSwap(() => setPage(null));
      await flush();
      expect(pinBox(), '等新页时副本钉在原处').not.toBeNull();
      document.body.append(page('todos'));
      await flush();
      expect(pinBox(), '新页出来就拿掉副本').toBeNull();
    });

    it('连点（上一次还在播就又切）：下一次的副本照样全亮，不会抄到透明（原来抄到新页头像的 opacity: 0，整段切页头像没了）', () => {
      document.body.replaceChildren(page('today'));
      fadeSwap(() => document.querySelector('main')?.replaceWith(page('todos')));
      fadeSwap(() => setPage(null));
      const copy = pinBox()?.querySelector('[data-swap-pin]') as HTMLElement | null;
      expect(copy).not.toBeNull();
      expect(copy?.style.opacity).toBe('');
      expect(getComputedStyle(pinBox() as Element).visibility).not.toBe('hidden');
    });

    it('还在等新页（旧页被藏着）时又切：接着用上一次的快照和钉住的头像，不去拷藏着的旧页（量不出位置，头像会跑到左边）', async () => {
      document.body.replaceChildren(page('today'));
      fadeSwap(() => ((document.querySelector('main') as HTMLElement).style.display = 'none'));
      await flush();
      const ghost = document.querySelector('[data-tab-ghost]');
      const box = pinBox();
      expect(box).not.toBeNull();
      fadeSwap(() => undefined);
      await flush();
      expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(1);
      expect(document.querySelector('[data-tab-ghost]')).toBe(ghost);
      expect(pinBox()).toBe(box);
      document.querySelector('main')?.remove();
      document.body.append(page('notes'));
      await flush();
      expect(pinBox(), '新页出来就拿掉副本').toBeNull();
    });

    it('新页里没有头像（电脑版藏了）：副本跟着快照一起淡出', () => {
      document.body.replaceChildren(page('today'));
      fadeSwap(() => setPage('settings'));
      const box = pinBox();
      expect(box).not.toBeNull();
      expect(anims.find((a) => a.el === box)?.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    });
  });

  it('旧页快照：换页前拷一份旧 main 盖在新页那一层，和日历一样模糊到 4px、前 2/3 淡没；去掉 id、data-testid，读屏不念、不接点按；放完拿掉', async () => {
    setPage('today');
    const old = document.querySelector('main') as HTMLElement;
    old.append(Object.assign(document.createElement('h1'), { id: 'ttl', textContent: '今天' }));
    const tinted = document.createElement('p');
    tinted.style.color = 'red';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // 打的字、勾的框、选的项不在属性里，也要抄上（代码审查 M6）
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    box.checked = true;
    const text = document.createElement('textarea');
    text.value = '买牛奶';
    const sel = document.createElement('select');
    sel.append(new Option('甲', 'a'), new Option('乙', 'b'));
    sel.value = 'b';
    old.append(tinted, svg, box, text, sel);
    const setAttr = vi.spyOn(Element.prototype, 'setAttributeNS');
    old.dataset.testid = 'today';
    const p = fadeSwap(() => setPage('calendar'));
    const ghost = anims[1]?.el as HTMLElement;
    expect(anims).toHaveLength(2);
    expect(anims[1]?.frames).toEqual(blurSwapOut(false));
    expect(anims[1]?.frames[1]).toEqual({ opacity: 0, filter: `blur(${(4 * 2) / 3}px)`, transform: 'translateX(0px)', offset: 2 / 3 });
    expect(anims[1]?.opts).toEqual({ ...anims[0]?.opts, fill: 'forwards' });
    expect(ghost.style.visibility, '新页出来了，快照显示').toBe('');
    expect((ghost.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect((ghost.querySelector('textarea') as HTMLTextAreaElement).value).toBe('买牛奶');
    expect((ghost.querySelector('select') as HTMLSelectElement).value).toBe('b');
    // 快照是静止的一张：里面的 CSS 动画、过渡停住
    expect((ghost.querySelector('p') as HTMLElement).style.animation).toBe('none');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.style.pointerEvents).toBe('none');
    expect(ghost.style.position).toBe('fixed');
    expect(ghost.querySelector('[id],[data-testid]'), '拷贝里不留 id、data-testid').toBeNull();
    expect(ghost.textContent).toContain('今天');
    // 内联样式走 CSSOM 抄（页面 CSP 不许内联 style 属性）；SVG 还是 SVG
    expect(setAttr.mock.calls.some((c) => c[1] === 'style')).toBe(false);
    setAttr.mockRestore();
    expect((ghost.querySelector('p') as HTMLElement).style.color).toBe('red');
    expect(ghost.querySelector('svg')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(document.querySelectorAll('main'), '快照不是 main，页面上只找得到新页').toHaveLength(1);
    expect(ghost.nextElementSibling).toBe(document.querySelector('main'));
    expect(ghost.querySelector('[data-feature]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="today"]')).toHaveLength(0);
    anims[1]?.finish();
    anims[0]?.finish();
    await p;
    await Promise.resolve();
    expect(ghost.isConnected, '放完拿掉').toBe(false);
  });

  it('连点时上一次的旧页快照立即拿掉，屏上最多一份', () => {
    setPage('today');
    fadeSwap(() => setPage('calendar'));
    const g1 = anims[1]?.el as HTMLElement;
    fadeSwap(() => setPage('todos'));
    expect(g1.isConnected).toBe(false);
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    cancelFade();
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it('减少动态效果：不留旧页快照', async () => {
    document.documentElement.setAttribute('data-rm', '1');
    setPage('today');
    await fadeSwap(() => setPage('calendar'));
    expect(anims).toHaveLength(0);
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it('减少动态效果（data-rm="1"）：只换页，不动', async () => {
    document.documentElement.setAttribute('data-rm', '1');
    const update = vi.fn(() => {
      setPage('x');
    });
    await fadeSwap(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(anims).toHaveLength(0);
  });

  it('新页分包还没到：等 main 出来再淡入，放完才 resolve；FADE_WAIT_MS 内一直没出来就不淡了', async () => {
    const p = fadeSwap(() => undefined);
    expect(anims).toHaveLength(0);
    document.body.append(document.createElement('main'));
    await flush();
    expect(anims).toHaveLength(1);
    anims[0]?.finish();
    await p;

    vi.useFakeTimers();
    const q = fadeSwap(() => {
      setPage(null);
    });
    vi.advanceTimersByTime(FADE_WAIT_MS);
    // 等不到：不放动画，快照再留一阵（复审第 4 条），30 秒还没新页才收
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    await expect(q).resolves.toBeUndefined();
    expect(anims).toHaveLength(1);
  });

  it('新页分包没到、旧页的 main 还留着：不给旧页淡入，等新页的 main 换上来再淡', async () => {
    setPage('today');
    const old = document.querySelector('main');
    const p = fadeSwap(() => undefined);
    expect(anims).toHaveLength(0);
    setPage('todos');
    await flush();
    // 新页 main 一个，旧页快照一个
    expect(anims).toHaveLength(2);
    expect(anims[0]?.el).not.toBe(old);
    expect(anims[0]?.el.getAttribute('data-feature')).toBe('todos');
    expect((anims[1]?.el as HTMLElement).getAttribute('aria-hidden')).toBe('true');
    anims[0]?.finish();
    await p;
  });

  it('分包晚到、旧页已经卸掉新页还没出来（M2）：快照先藏着，旧页一卸掉就显示，不露一段空白；新页出来再动', async () => {
    setPage('today');
    void fadeSwap(() => undefined);
    const ghost = document.querySelector<HTMLElement>('[data-tab-ghost]');
    expect(ghost?.style.visibility, '旧页还在屏上：快照藏着，不叠两份').toBe('hidden');
    setPage(null);
    await flush();
    expect(ghost?.style.visibility, '旧页卸掉了：快照顶上').toBe('');
    expect(anims).toHaveLength(0);
    setPage('todos');
    await flush();
    expect(anims).toHaveLength(2);
  });

  it('还在等分包时又点了别的页签：上一次不再等（不会晚到时再淡一次）', async () => {
    const p1 = fadeSwap(() => undefined);
    const p2 = fadeSwap(() => {
      setPage('x');
    });
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
    void fadeSwap(p.swap);
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
    void fadeSwap(p.swap);
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
    void fadeSwap(p.swap);
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
    void fadeSwap(p.swap);
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
    void fadeSwap(p.swap);
    vi.advanceTimersByTime(200);
    expect(down(p.del)).toBe(true);
    tapClick(p.del);
    expect(p.onDel).toHaveBeenCalledTimes(2);
  });

  it('窗口内键盘的 click（先 keydown：焦点在按钮上按回车）照常，不当成手指点在旧画面上', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap);
    vi.advanceTimersByTime(10);
    p.del.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tapClick(p.del, 0)).toBe(true);
    expect(p.onDel).toHaveBeenCalledTimes(1);
  });

  it('吞掉的那一下用 stopImmediatePropagation：document 上后挂的捕获监听也收不到', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const p = pageWithButtons();
    void fadeSwap(p.swap);
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
    void fadeSwap(p.swap);
    tapClick(p.del);
    expect(p.onDel).not.toHaveBeenCalled();
  });

  it('摘监听：窗口过了、下一次换页、cancelFade 都摘掉，document 上不留', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const add = vi.spyOn(document, 'addEventListener');
    const rm = vi.spyOn(document, 'removeEventListener');
    const live = (): number => add.mock.calls.filter((c) => c[2] === true).length - rm.mock.calls.filter((c) => c[2] === true).length;
    void fadeSwap(() => setPage('a'));
    expect(live()).toBe(3); // pointerdown、click、keydown（晚到那一下和 S12 的 pointercancel 在 swallowNextClick 里、挂在 window 上，见 swallow-click.test.ts）
    void fadeSwap(() => setPage('b'));
    expect(live()).toBe(3); // 上一次的摘了，这一次的挂上
    vi.advanceTimersByTime(FADE_GUARD_MS + 1);
    expect(live()).toBe(0);
    void fadeSwap(() => setPage('c'));
    cancelFade();
    expect(live()).toBe(0);
    add.mockRestore();
    rm.mockRestore();
  });
});

describe('只换一栏（fadeSwap 的 part：网页版宽屏设置里换层，负责人 11-25“详情也模糊淡入”“侧栏、左目录不动”）', () => {
  /** 设置页：同一个 main 里左目录（nav）和打了 data-swap-part 的右边详情 */
  const settings = () => {
    const main = document.createElement('main');
    main.dataset.feature = 'settings';
    const go = el('button', 'group');
    const nav = el('nav', 'dir', go);
    const detail = el('section', 'detail', el('p', 'old'));
    detail.setAttribute('data-swap-part', '');
    main.append(nav, detail);
    document.body.append(main);
    return { main, nav, go, detail };
  };

  it('快照只抄那一栏（标签不变、不再带 data-swap-part、钉住原高）；同一份关键帧只加在新那一栏里面和快照上，main、目录不动', () => {
    const { main, nav, detail } = settings();
    void fadeSwap(() => detail.replaceChildren(el('p', 'new')), true);
    expect(document.querySelector('main'), 'main 还是那一个').toBe(main);
    const ghost = document.querySelectorAll<HTMLElement>('[data-tab-ghost]');
    expect(ghost).toHaveLength(1);
    const copy = ghost[0]?.querySelector('section');
    expect(copy, '抄的是那一栏').not.toBeNull();
    expect(copy?.hasAttribute('data-swap-part')).toBe(false);
    expect(copy?.style.height).toBe('0px');
    expect(ghost[0]?.querySelector('nav'), '目录不进快照').toBeNull();
    expect(anims.length).toBeGreaterThan(0);
    for (const a of anims) expect(a.el === ghost[0] || detail.contains(a.el), `动画加在了 ${a.el.tagName}#${a.el.id}`).toBe(true);
    expect(anims.some((a) => nav.contains(a.el) || a.el === main)).toBe(false);
    const fade = anims.find((a) => detail.contains(a.el));
    expect(fade?.frames).toEqual(blurSwapIn(false));
    expect(fade?.opts).toEqual(blurSwapTiming(false));
    expect(anims.find((a) => a.el === ghost[0])?.frames).toEqual(blurSwapOut(false, 0, 1));
  });

  it('换后吞点按只管那一栏：详情里的吞掉，左目录照常能点（点目录换组不被吞）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { go, detail } = settings();
    const row = el('button', 'row');
    const onRow = vi.fn();
    const onGo = vi.fn();
    row.addEventListener('click', onRow);
    go.addEventListener('click', onGo);
    void fadeSwap(() => detail.replaceChildren(row), true);
    vi.advanceTimersByTime(10);
    row.click();
    expect(onRow).not.toHaveBeenCalled();
    go.click();
    expect(onGo).toHaveBeenCalledTimes(1);
  });
});

describe('等分包时走了别的导航（代码审查方案 B M9）', () => {
  it('等的时候走了 transition()：整页推页换上来的页不再淡入', async () => {
    const fade = (): FakeAnim[] => anims.filter((a) => JSON.stringify(a.frames) === JSON.stringify(blurSwapIn(false)));
    setPage('today');
    void fadeSwap(() => undefined); // 分包没到，旧页还在
    const p = transition(() => setPage('edit'));
    for (const a of anims) a.finish();
    await p;
    await Promise.resolve();
    expect(fade()).toHaveLength(0);
    setPage('todos'); // 分包这时才到也不淡
    await Promise.resolve();
    expect(fade()).toHaveLength(0);
  });

  it('等的时候同页内切换（cancelFade(false)）：后来换上来的不淡；正在播的淡入不打断', async () => {
    void fadeSwap(() => setPage('a'));
    expect(anims).toHaveLength(1);
    cancelFade(false);
    expect(anims[0]?.cancel).not.toHaveBeenCalled();
    setPage('today');
    void fadeSwap(() => undefined);
    cancelFade(false);
    setPage('cal');
    await Promise.resolve();
    expect(anims).toHaveLength(1);
  });
});

describe('growSwap（打字条“详细”长成新建页，负责人 11-18 选 A）', () => {
  const card = { top: 500, left: 16, right: 359, bottom: 620, width: 343, height: 120 } as DOMRect;
  it('旧页快照垫在旧页原来的位置；新建页 main 用 clip-path 从卡的位置和圆角长到整页，280ms、--ease-drawer；遮罩前 35% 不透明后淡出；打字条前 35% 淡出', async () => {
    setPage('today');
    const bar = document.createElement('form');
    document.body.append(bar);
    const landed = vi.fn();
    const p = growSwap(() => setPage('event'), card, 20, bar, landed);
    const main = document.querySelector('main') as HTMLElement;
    expect(main.dataset.feature).toBe('event');
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(1);
    expect(dur.grow).toBe(0.28);
    expect(GROW_HOLD).toBe(0.35);
    const grow = anims[0];
    expect(grow?.el).toBe(main);
    expect(grow?.frames).toEqual([{ clipPath: 'inset(500px -359px -620px 16px round 20px)' }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }]);
    expect(grow?.opts).toEqual({ duration: dur.grow * 1000, easing: bezierCss(ease.drawer), fill: 'both' });
    expect(main.style.position).toBe('relative');
    expect(anims[1]?.frames).toEqual([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0, offset: 1 }]);
    expect(anims[2]?.el).toBe(bar);
    expect(anims[2]?.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(anims[2]?.opts.duration).toBeCloseTo(98, 6);
    let resolved = false;
    void p.then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved, '放完才 resolve').toBe(false);
    expect(main.style.zIndex).toBe('calc(var(--z-mist) + 1)');
    expect(main.style.background).toBe('var(--scr-bg, var(--bg))');
    // 长完：先收打字条（landed），打字条卸掉以后才还原层级（H2：反过来会露一帧被模糊层盖住的新建页）
    grow?.finish();
    await flush();
    expect(landed).toHaveBeenCalledTimes(1);
    expect(main.style.zIndex, '打字条还在：层级先不还原').toBe('calc(var(--z-mist) + 1)');
    bar.remove();
    await p;
    expect(landed).toHaveBeenCalledTimes(1);
    expect(main.getAttribute('style') ?? '', '临时样式还原').toBe('');
    expect(main.children).toHaveLength(0);
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(0);
    expect(anims[2]?.cancel, '打字条的淡出不取消，收走以前一直透明').not.toHaveBeenCalled();
  });

  it('门面从卡量（motion/index.ts 的 growSwap → page-swap.ts 的 growFrom，11-25 量法从 App 挪进实现）：位置照卡的框、圆角照卡的左上圆角', async () => {
    setPage('today');
    const bar = document.createElement('form');
    bar.style.borderTopLeftRadius = '20px';
    bar.getBoundingClientRect = () => card;
    document.body.append(bar);
    const landed = vi.fn();
    const p = growFromCard(() => setPage('event'), bar, landed);
    expect(anims[0]?.frames).toEqual([{ clipPath: 'inset(500px -359px -620px 16px round 20px)' }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }]);
    expect(anims[2]?.el, '打字条就是这张卡').toBe(bar);
    cancelFade();
    bar.remove();
    await p;
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('被打断（cancelFade，例如马上点了返回）：一样还原样式、拿掉快照', async () => {
    setPage('today');
    const landed = vi.fn();
    const p = growSwap(() => setPage('event'), card, 20, null, landed);
    cancelFade();
    await p;
    expect(landed, '被打断也收打字条，只收一次').toHaveBeenCalledTimes(1);
    expect(document.querySelector('main')?.getAttribute('style') ?? '').toBe('');
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(0);
  });

  it('新建页分包迟迟不到（评审中⑥）：FADE_WAIT_MS 一到就先收打字条，不等 30 秒；快照照样留着等新页', async () => {
    vi.useFakeTimers();
    setPage('today');
    const landed = vi.fn();
    const p = growSwap(() => setPage(null), card, 20, null, landed);
    vi.advanceTimersByTime(FADE_WAIT_MS + 10);
    expect(landed, '到点就收打字条').toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-tab-ghost]'), '快照还在，不露空白').toHaveLength(1);
    setPage('event');
    await flush();
    await p;
    expect(landed, '新页出来收尾时不再调第二次').toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(0);
  });

  it('减少动态效果：只换页，不动、不留快照', async () => {
    document.documentElement.setAttribute('data-rm', '1');
    setPage('today');
    const landed = vi.fn();
    await growSwap(() => setPage('event'), card, 20, null, landed);
    expect(landed).toHaveBeenCalledTimes(1);
    expect(anims).toHaveLength(0);
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(0);
  });
});

describe('第二次复审：旧页被 Suspense 藏起来、等不到、出错', () => {
  /** 像 React 19 + flushSync：新页分包没到时旧页留在文档里、内联 display: none 藏起来 */
  const hideOld = (): void => {
    for (const m of document.querySelectorAll('main')) m.style.setProperty('display', 'none', 'important');
  };
  const ghost = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-tab-ghost]');

  it('旧页被藏起来（仍在文档里）就显示快照，不露空白；新页出来再起动画（复审第 1 条）', async () => {
    setPage('today');
    void fadeSwap(hideOld);
    expect(ghost()?.style.visibility).toBe('');
    expect(anims).toHaveLength(0);
    setPage('calendar');
    await flush();
    expect(anims.length).toBeGreaterThan(0);
  });

  it('旧页 main 外还包着一层、Suspense 藏的是外层（隐私记页 data-testid="vault"，评审高①）：快照挂在 app 最外层前面，不跟着被藏、不露白屏', async () => {
    const root = document.createElement('div');
    const vault = document.createElement('div');
    vault.dataset.testid = 'vault';
    const m = document.createElement('main');
    m.dataset.feature = 'vault';
    vault.append(m);
    root.append(vault);
    document.body.append(root);
    void fadeSwap(() => vault.style.setProperty('display', 'none', 'important'));
    await flush();
    const g = ghost();
    expect(g?.parentElement, '挂在 body 下').toBe(document.body);
    expect(g?.nextElementSibling, '在 app 最外层前面（层级同原来）').toBe(root);
    expect(g?.closest('[style*="display: none"]'), '不在被藏的那层里').toBeNull();
    expect(g?.style.visibility, '旧页被藏：快照顶上').toBe('');
  });

  it('连点时拷到的是被藏起来的旧页：快照不带 display: none（复审第 2 条）', () => {
    setPage('today');
    void fadeSwap(hideOld);
    void fadeSwap(() => undefined);
    const copy = ghost()?.firstElementChild as HTMLElement | null;
    expect(copy?.style.display).toBe('');
    expect(ghost()?.style.visibility).toBe('');
  });

  it('等不到新页（FADE_WAIT_MS）：不放动画，快照留着，新页出来才拿掉（复审第 4 条）', async () => {
    vi.useFakeTimers();
    setPage('today');
    const p = fadeSwap(hideOld);
    vi.advanceTimersByTime(FADE_WAIT_MS + 10);
    expect(ghost(), '超时后快照还在').not.toBeNull();
    setPage('calendar');
    await flush();
    await p;
    expect(ghost()).toBeNull();
    expect(anims, '晚到的新页不补动画').toHaveLength(0);
  });

  it('play 里出错（长成拿不到尺寸之类）：当场收尾，landed 照调，不卡住（复审第 3 条）', async () => {
    setPage('today');
    const landed = vi.fn();
    Element.prototype.animate = (() => {
      throw new Error('boom');
    }) as unknown as Element['animate'];
    const card = { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 } as DOMRect;
    await growSwap(() => setPage('event'), card, 0, null, landed);
    expect(landed).toHaveBeenCalledTimes(1);
    expect(ghost()).toBeNull();
    expect(document.querySelector('main')?.getAttribute('style') ?? '').toBe('');
  });

  it('update 出错：快照拿掉、错误照抛（复审第 15 条）', () => {
    setPage('today');
    expect(() =>
      fadeSwap(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(ghost()).toBeNull();
  });

  it('长成被打断时 landed 当场同步调（复审第 7 条）', () => {
    setPage('today');
    const landed = vi.fn();
    const card = { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 } as DOMRect;
    void growSwap(() => setPage('event'), card, 0, null, landed);
    cancelFade();
    expect(landed).toHaveBeenCalledTimes(1);
  });
});
