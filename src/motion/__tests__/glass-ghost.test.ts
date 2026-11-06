// 液态玻璃的玻璃标记、帧循环（B2 FA-7，motion/glass-ghost.ts；11-06 起不再建内容副本 GLASS-copy-unused；自动深浅 11-06 取消，底栏后实色）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playGel, startGlass } from '../glass-ghost.ts';

let frames: FrameRequestCallback[] = [];
const runFrames = (n = 3): void => {
  for (let k = 0; k < n; k++) {
    const fs = frames;
    frames = [];
    for (const f of fs) f(performance.now());
  }
};

describe('startGlass', () => {
  let nav: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
      frames.push(f);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    nav = document.createElement('nav');
    const main = document.createElement('main');
    main.append('交报告');
    document.body.replaceChildren(main, nav);
  });
  afterEach(() => {
    vi.restoreAllMocks(); // performance.now 的 spy 每条用例后还原（代码审查 p1 S2）
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-rt');
    frames = [];
  });

  it('开着时玻璃块写 data-glass="copy"，不往玻璃块里放任何东西（11-06 起不建副本层）；停掉时摘掉', () => {
    const drop = document.createElement('span');
    nav.append(drop);
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }, { el: drop, fx: 'drop' }] });
    runFrames();
    expect(nav.dataset['glass']).toBe('copy');
    expect(drop.dataset['glass']).toBe('copy');
    expect(nav.children.length).toBe(1); // 只有原来的液滴
    expect(drop.children.length).toBe(0);
    expect(document.body.textContent?.match(/交报告/g)?.length).toBe(1); // 页面内容没被复制
    g.stop();
    expect(nav.dataset['glass']).toBeUndefined();
    expect(drop.dataset['glass']).toBeUndefined();
  });

  it('自动深浅取消（11-06 底栏后实色）：引擎从不写 data-ad', () => {
    const dark = document.createElement('section');
    dark.style.backgroundColor = 'rgb(30, 31, 36)';
    document.querySelector('main')?.append(dark);
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }] });
    runFrames();
    expect(nav.hasAttribute('data-ad')).toBe(false);
    g.stop();
  });

  it('减少透明效果（:root[data-rt="1"]）：不写 data-glass；中途打开、关掉都跟着变', async () => {
    document.documentElement.dataset['rt'] = '1';
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }] });
    runFrames();
    expect(nav.dataset['glass']).toBeUndefined();
    document.documentElement.removeAttribute('data-rt');
    await Promise.resolve();
    runFrames();
    expect(nav.dataset['glass']).toBe('copy');
    document.documentElement.dataset['rt'] = '1';
    await Promise.resolve();
    runFrames();
    expect(nav.dataset['glass']).toBeUndefined();
    g.stop();
  });

  it('帧循环只在有事时跑：一次 poke 跑完就停（没有一直排着下一帧）；滚动不再叫醒它', () => {
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }] });
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    runFrames(1);
    expect(frames.length).toBe(0);
    dispatchEvent(new Event('scroll'));
    expect(frames.length).toBe(0);
    g.poke();
    expect(frames.length).toBe(1);
    g.stop();
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
