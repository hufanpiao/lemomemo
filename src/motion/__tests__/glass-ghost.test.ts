// 液态玻璃的玻璃标记（B2 FA-7，motion/glass-ghost.ts；11-06 起不再建内容副本 GLASS-copy-unused；自动深浅 11-06 取消，底栏后实色；11-20 删掉帧循环）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetTilt, markGlass, playGel } from '../glass-ghost.ts';

/** MutationObserver 回调是微任务：等它跑完 */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('markGlass', () => {
  let nav: HTMLElement;
  let raf: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    nav = document.createElement('nav');
    const main = document.createElement('main');
    main.append('交报告');
    document.body.replaceChildren(main, nav);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-rt');
    document.documentElement.removeAttribute('data-solid');
  });

  it('一调就给玻璃块写 data-glass="copy"，不往玻璃块里放任何东西（11-06 起不建副本层）；停掉时摘掉', () => {
    const plus = document.createElement('button');
    document.body.append(plus);
    const stop = markGlass([nav, plus]);
    expect(nav.dataset['glass']).toBe('copy');
    expect(plus.dataset['glass']).toBe('copy');
    expect(nav.children.length).toBe(0);
    expect(document.body.textContent?.match(/交报告/g)?.length).toBe(1); // 页面内容没被复制
    expect(nav.hasAttribute('data-ad')).toBe(false); // 自动深浅取消（11-06）
    stop();
    expect(nav.dataset['glass']).toBeUndefined();
    expect(plus.dataset['glass']).toBeUndefined();
  });

  it('不排任何一帧（11-20 删掉帧循环：原来启动 18 帧、按一下底栏 24 帧、换页签 42 帧白跑）', async () => {
    const stop = markGlass([nav]);
    document.documentElement.dataset['rt'] = '1';
    await flush();
    dispatchEvent(new Event('scroll'));
    expect(raf).not.toHaveBeenCalled();
    stop();
  });

  it('减少透明效果（:root[data-rt="1"]）：不写 data-glass；中途打开、关掉都跟着变', async () => {
    document.documentElement.dataset['rt'] = '1';
    const stop = markGlass([nav]);
    expect(nav.dataset['glass']).toBeUndefined();
    document.documentElement.removeAttribute('data-rt');
    await flush();
    expect(nav.dataset['glass']).toBe('copy');
    document.documentElement.dataset['rt'] = '1';
    await flush();
    expect(nav.dataset['glass']).toBeUndefined();
    stop();
  });

  it('隐私记页强制实色（:root[data-solid="1"]）：同减少透明效果，不写 data-glass；放开后恢复', async () => {
    document.documentElement.dataset['solid'] = '1';
    const stop = markGlass([nav]);
    expect(nav.dataset['glass']).toBeUndefined();
    document.documentElement.removeAttribute('data-solid');
    await flush();
    expect(nav.dataset['glass']).toBe('copy');
    stop();
  });

  it('停掉以后不再跟着变', async () => {
    const stop = markGlass([nav]);
    stop();
    document.documentElement.dataset['rt'] = '1';
    await flush();
    document.documentElement.removeAttribute('data-rt');
    await flush();
    expect(nav.dataset['glass']).toBeUndefined();
  });
});

describe('playGel（果冻从当前形变接着放，设计动效评审 L1）', () => {
  const jelly = (): { el: HTMLElement; calls: [Keyframe[], KeyframeAnimationOptions][]; cancel: ReturnType<typeof vi.fn> } => {
    const el = document.createElement('span');
    el.style.setProperty('--dur-drop', '.55s');
    el.style.setProperty('--ease-gel', 'cubic-bezier(.3,.9,.4,1)');
    document.body.append(el);
    const calls: [Keyframe[], KeyframeAnimationOptions][] = [];
    const cancel = vi.fn();
    Object.assign(el, {
      animate: (k: Keyframe[], o: KeyframeAnimationOptions) => {
        calls.push([k, o]);
        return {} as Animation;
      },
      getAnimations: () => [{ cancel } as unknown as Animation],
    });
    return { el, calls, cancel };
  };
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-rm');
  });

  it('没有 WAAPI：返回 false（GlassBar 退回 CSS 动画）', () => {
    expect(playGel(document.createElement('span'))).toBe(false);
  });

  it('先停掉正在放的，从当前形变开始；关键帧、时长、曲线照 CSS 的 gel', () => {
    const { el, calls, cancel } = jelly();
    el.style.scale = '1.2 0.88'; // 正在形变中
    expect(playGel(el)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    const [k, o] = calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(k.map((f) => f['scale'])).toEqual(['1.2 0.88', '1.22 0.86', '0.96 1.04', '1']);
    expect(k.map((f) => f.offset)).toEqual([undefined, 0.35, 0.7, undefined]);
    expect(k[0]?.easing).toBe('cubic-bezier(.3,.9,.4,1)');
    expect(o.duration).toBe(550);
  });

  it('减少动态效果：停掉正在放的、不再放', () => {
    document.documentElement.dataset['rm'] = '1';
    const { el, calls, cancel } = jelly();
    expect(playGel(el)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(0);
  });
});

describe('forgetTilt（R-373）', () => {
  it('删掉以前存的倾斜高光开关；本机存储读写不了也不抛', () => {
    localStorage.setItem('lemo.tilt', '1');
    forgetTilt();
    expect(localStorage.getItem('lemo.tilt')).toBeNull();
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => forgetTilt()).not.toThrow();
    spy.mockRestore();
  });
});
