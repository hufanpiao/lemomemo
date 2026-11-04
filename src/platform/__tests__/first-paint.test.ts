// 首屏画完（B2 FA-6 ①，src/platform/first-paint.ts）：第一个功能页出现后再过一帧算画完；兜底两段（挂上起算的长兜底、render 后起算的时限）；没人挂过时当场执行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterAppPainted, appPainted, APP_PAINT_BACKSTOP_MS, resetAppPaintedForTest, startAppPaintLimit, watchAppPainted, type FrameScheduler } from '../first-paint.ts';

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
  resetAppPaintedForTest();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  vi.useRealTimers();
  root.remove();
  resetAppPaintedForTest();
});

describe('first-paint', () => {
  it('没人挂过 watchAppPainted：afterAppPainted 当场执行', () => {
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('功能页出现以后再过一帧才执行；之前排着的按顺序执行，之后来的当场执行', async () => {
    const f = frames();
    watchAppPainted(root, f.next);
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

  it('挂的时候功能页已经在了：等一帧就算画完', () => {
    put('main', 'onboarding');
    const f = frames();
    watchAppPainted(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    expect(fn).not.toHaveBeenCalled();
    f.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('一直没有功能页（整屏提示）：render 后的时限到了也算画完；之后功能页才出现也不再重复执行', () => {
    vi.useFakeTimers();
    const f = frames();
    watchAppPainted(root, f.next);
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
    watchAppPainted(root, f.next);
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
    watchAppPainted(root, frames().next);
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
    watchAppPainted(root, f.next);
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
    watchAppPainted(root, f.next);
    const fn = vi.fn();
    afterAppPainted(fn);
    vi.advanceTimersByTime(APP_PAINT_BACKSTOP_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('startAppPaintLimit：没挂过、已画完时不计时；重复调用只计第一次', () => {
    vi.useFakeTimers();
    startAppPaintLimit(1000);
    expect(vi.getTimerCount()).toBe(0);
    watchAppPainted(root, frames().next);
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

  it('只挂一次：第二次 watchAppPainted 不起作用；一个回调出错不挡别的', () => {
    const f1 = frames();
    const f2 = frames();
    put('main', 'today');
    watchAppPainted(root, f1.next);
    watchAppPainted(root, f2.next);
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
    const stop = watchAppPainted(root, f.next, 4000);
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
