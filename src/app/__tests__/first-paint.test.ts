// 入口接首屏画完、#root 画出东西（src/app/first-paint.ts）：页面口径是“显示着的 <main>”（motion 的 shownMain，jsdom 里的显示判断见
// tests/fakes/jsdom-layout-setup.ts），出现以后再过一帧才算画完；后台标签页那一帧不来靠 root-paint 的时限；whenContent 的“画出东西”口径
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterAppPainted, APP_PAINT_BACKSTOP_MS, resetRootPaintForTest, startAppPaintLimit } from '../../platform/root-paint.ts';
import { watchFirstPaint, whenContent, type FrameScheduler } from '../first-paint.ts';

/** 手动放行的“下一帧” */
function frames() {
  const q: (() => void)[] = [];
  const next: FrameScheduler = (fn) => {
    q.push(fn);
    return () => {
      const i = q.indexOf(fn);
      if (i >= 0) q.splice(i, 1);
    };
  };
  return { next, run: () => { for (const f of q.splice(0)) f(); }, size: () => q.length };
}

/** 换掉 root 里的内容：tag 加上可选的 data-feature（不用 innerHTML，A22） */
function put(tag: string, feature?: string): HTMLElement {
  const el = document.createElement(tag);
  if (feature) el.dataset['feature'] = feature;
  root.replaceChildren(el);
  return el;
}

/** 让 MutationObserver 的回调（微任务）跑完 */
const flush = () => new Promise<void>((ok) => setTimeout(ok, 0));

let root: HTMLElement;
let stop: () => void = () => undefined;
beforeEach(() => {
  resetRootPaintForTest();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  stop();
  stop = () => undefined;
  vi.useRealTimers();
  root.remove();
  resetRootPaintForTest();
});

describe('watchFirstPaint：显示着的页面出来再过一帧算首屏画完', () => {
  it('启动画面、整屏提示（不是 main）不算；main 出来以后再过一帧才执行', async () => {
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    put('div');
    await flush();
    expect(f.size()).toBe(0);
    put('main', 'today');
    await flush();
    expect(fn).not.toHaveBeenCalled();
    expect(f.size()).toBe(1);
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('FIRSTPAINT-nofeature：根是不带 data-feature 的 <main>（编辑页、整页提醒）也算；别的元素带 data-feature 不算', async () => {
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    put('section', 'today');
    await flush();
    f.run();
    expect(fn).not.toHaveBeenCalled();
    put('main');
    await flush();
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('被 Suspense 藏着（内联 display: none）的 main 不算，显示出来才算', async () => {
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    const m = put('main', 'today');
    m.style.setProperty('display', 'none', 'important');
    await flush();
    expect(f.size()).toBe(0);
    m.style.removeProperty('display');
    await flush();
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('挂的时候页面已经在了：等一帧就算画完', () => {
    put('main', 'onboarding');
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).not.toHaveBeenCalled();
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('后台标签页（审查 L2）：页面已出现、那一帧一直不来（rAF 不跑），render 后的时限到了照样放行', async () => {
    vi.useFakeTimers();
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    put('main', 'today');
    await Promise.resolve();
    expect(f.size()).toBe(1);
    startAppPaintLimit(6000);
    vi.advanceTimersByTime(6000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('一直没有页面：长兜底到了放行，同时停掉等待（之后页面出来不再排那一帧）', async () => {
    vi.useFakeTimers();
    const f = frames();
    stop = watchFirstPaint(f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(APP_PAINT_BACKSTOP_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    put('main', 'today');
    await Promise.resolve();
    expect(f.size()).toBe(0);
  });

  it('取消函数：停掉等待、兜底和排着的那一帧（测试用）', () => {
    vi.useFakeTimers();
    put('main', 'today');
    const f = frames();
    const off = watchFirstPaint(f.next, 4000);
    startAppPaintLimit(4000);
    expect(f.size()).toBe(1);
    off();
    expect(f.size()).toBe(0);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('whenContent 的“画出东西”口径：有元素子节点或非空白文本（不等帧）', () => {
  it('还是空的：不执行；画出第一个元素以后执行一次，之后再画不再执行；已经有东西就当场执行', async () => {
    const fn = vi.fn();
    whenContent(root, fn);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(true);
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    const now = vi.fn();
    whenContent(root, now);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('纯空白文本、注释节点不算；挂上之前就有的空白（index.html 格式化过）也不算；空白原地改成文字算', async () => {
    root.appendChild(document.createTextNode('\n  '));
    const fn = vi.fn();
    whenContent(root, fn);
    root.appendChild(document.createTextNode('\n    '));
    root.appendChild(document.createComment('react'));
    await flush();
    expect(fn).not.toHaveBeenCalled();
    const t = document.createTextNode('  ');
    root.appendChild(t);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    t.data = '出错了';
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('取消函数能撤掉还没等到的那一次', async () => {
    const fn = vi.fn();
    const off = whenContent(root, fn);
    off();
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('给了时限：时限内一直没东西调 hit(false)', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    whenContent(root, fn, 1000);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledWith(false);
  });
});
