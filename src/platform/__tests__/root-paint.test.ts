// #root 画出东西了没有（src/platform/root-paint.ts）：whenContent / whenPage 的口径；首屏画完 = 第一个页面出现后再过一帧，兜底两段（挂上起算的长兜底、render 后起算的时限）；没人挂过时当场执行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterAppPainted, appPainted, APP_PAINT_BACKSTOP_MS, isAppPainted, pageShown, resetRootPaintForTest, startAppPaintLimit, watchRoot, whenContent, whenPage, type FrameScheduler,
} from '../root-paint.ts';

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
function put(tag: string, feature?: string): void {
  const el = document.createElement(tag);
  if (feature) el.dataset['feature'] = feature;
  root.replaceChildren(el);
}

/** 让 MutationObserver 的回调（微任务）跑完 */
const flush = () => new Promise<void>((ok) => setTimeout(ok, 0));

let root: HTMLElement;
beforeEach(() => {
  resetRootPaintForTest();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  vi.useRealTimers();
  root.remove();
  resetRootPaintForTest();
});

describe('首屏画完', () => {
  it('没人挂过 watchRoot：afterAppPainted 当场执行、isAppPainted 为真', () => {
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isAppPainted()).toBe(true);
  });

  it('功能页出现以后再过一帧才执行；之前排着的按顺序执行，之后来的当场执行', async () => {
    const f = frames();
    watchRoot(root, f.next);
    const seen: string[] = [];
    afterAppPainted(() => seen.push('a'));
    const p = appPainted().then(() => seen.push('p'));
    // 启动画面、整屏提示：不算
    put('div');
    await flush();
    expect(f.size()).toBe(0);
    put('main', 'today');
    await flush();
    expect(seen).toEqual([]);
    expect(f.size()).toBe(1);
    f.run();
    await p;
    expect(seen).toEqual(['a', 'p']);
    afterAppPainted(() => seen.push('b'));
    expect(seen).toEqual(['a', 'p', 'b']);
  });

  it('FIRSTPAINT-nofeature：根是不带 data-feature 的 <main>（编辑页、整页提醒）也算画完；别的元素带 data-feature 不算', async () => {
    const f = frames();
    watchRoot(root, f.next);
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

  it('挂的时候功能页已经在了：等一帧就算画完', () => {
    put('main', 'onboarding');
    const f = frames();
    watchRoot(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).not.toHaveBeenCalled();
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('一直没有功能页（整屏提示）：render 后的时限到了也算画完；之后功能页才出现也不再重复执行', () => {
    vi.useFakeTimers();
    const f = frames();
    watchRoot(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    startAppPaintLimit(6000);
    vi.advanceTimersByTime(5999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    put('main', 'today');
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('时限从 render 起算（审查 L1）：冷启动慢（挂上以后过了好几秒才 render）不会提前用完；没 render 只靠长兜底', () => {
    vi.useFakeTimers();
    const f = frames();
    watchRoot(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    // 迁移、库被别的标签页挡住：10 秒后才 render
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    startAppPaintLimit(6000);
    put('main', 'today');
    return Promise.resolve().then(() => {
      // 页面出来、下一帧到了才算，不是时限
      expect(fn).not.toHaveBeenCalled();
      f.run();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('入口在 render 之前就走了（换账号）：长兜底 APP_PAINT_BACKSTOP_MS 到了也放行', () => {
    vi.useFakeTimers();
    watchRoot(root, frames().next);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(APP_PAINT_BACKSTOP_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('后台标签页（审查 L2）：功能页已出现、那一帧一直不来（rAF 不跑），时限到了照样放行', async () => {
    vi.useFakeTimers();
    const f = frames();
    watchRoot(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    put('main', 'today');
    await Promise.resolve();
    expect(f.size()).toBe(1);
    startAppPaintLimit(6000);
    vi.advanceTimersByTime(6000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('后台标签页、render 之前就看到了功能页：长兜底照样放行（看到功能页不清兜底）', async () => {
    vi.useFakeTimers();
    put('main', 'today');
    const f = frames();
    watchRoot(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(APP_PAINT_BACKSTOP_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('startAppPaintLimit：没挂过、已画完时不计时；重复调用只计第一次', () => {
    vi.useFakeTimers();
    startAppPaintLimit(1000);
    expect(vi.getTimerCount()).toBe(0);
    watchRoot(root, frames().next);
    startAppPaintLimit(1000);
    startAppPaintLimit(50_000);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); // 只剩长兜底（到点是空操作）
    startAppPaintLimit(1000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('只挂一次：第二次 watchRoot 不起作用；一个回调出错不挡别的', () => {
    const f1 = frames();
    const f2 = frames();
    put('main', 'today');
    watchRoot(root, f1.next);
    watchRoot(root, f2.next);
    expect(f2.size()).toBe(0);
    const fn = vi.fn();
    afterAppPainted(() => {
      throw new Error('boom');
    });
    afterAppPainted(fn);
    f1.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('取消函数：断开观察、清掉兜底和排着的那一帧（测试用）', () => {
    vi.useFakeTimers();
    put('main', 'today');
    const f = frames();
    const stop = watchRoot(root, f.next, 4000);
    startAppPaintLimit(4000);
    expect(f.size()).toBe(1);
    stop();
    expect(f.size()).toBe(0);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('whenContent 的“画出东西”口径：有元素子节点或非空白文本（不等帧）', () => {
  it('还是空的：不执行；画出第一个元素以后执行一次，之后再画不再执行；已经有东西就当场执行', async () => {
    watchRoot(root, frames().next);
    const fn = vi.fn();
    whenContent(fn);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    const now = vi.fn();
    whenContent(now);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('纯空白文本、注释节点不算；挂上之前就有的空白（index.html 格式化过）也不算；空白原地改成文字算', async () => {
    root.appendChild(document.createTextNode('\n  '));
    watchRoot(root, frames().next);
    const fn = vi.fn();
    whenContent(fn);
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
    watchRoot(root, frames().next);
    const fn = vi.fn();
    const stop = whenContent(fn);
    stop();
    root.appendChild(document.createElement('p'));
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('没挂过 watchRoot：看 document.body', async () => {
    const fn = vi.fn();
    whenContent(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('whenPage、pageShown：根里有没有页面（<main>，不等帧）', () => {
  it('首屏早就画完以后（告知页之后）也能等下一个页面；只看 <main>，别的元素不算', async () => {
    watchRoot(root, frames().next);
    put('main', 'onboarding');
    await flush();
    root.replaceChildren();
    expect(pageShown()).toBe(false);
    const fn = vi.fn();
    whenPage(fn);
    put('section', 'today');
    await flush();
    expect(fn).not.toHaveBeenCalled();
    put('main', 'today');
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pageShown()).toBe(true);
  });

  it('几个等待共用一个观察；都等到了就断开（之后的改动不再触发任何回调）', async () => {
    watchRoot(root, frames().next);
    const a = vi.fn();
    const b = vi.fn();
    whenContent(a);
    whenPage(b);
    put('div');
    await flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    put('main');
    await flush();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
