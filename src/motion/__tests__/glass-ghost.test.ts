// 液态玻璃内容副本、自动深浅、帧循环（B2 FA-7，motion/glass-ghost.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AD_OFF, AD_ON, isDarkEl, luminance, makeCopy, nextAd, playGel, startGlass } from '../glass-ghost.ts';

/** 搭 DOM（A22 不用 innerHTML）：h('li', { id: 'x' }, '文字', h('b')) */
function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
/** 元素和它所有后代的属性名 */
const attrNames = (el: Element): string[] => [el, ...el.querySelectorAll('*')].flatMap((n) => n.getAttributeNames());

describe('纯函数', () => {
  it('luminance：白 1、黑 0；半透明以下当没有背景', () => {
    expect(luminance('rgb(255, 255, 255)')).toBeCloseTo(1);
    expect(luminance('rgb(0, 0, 0)')).toBe(0);
    expect(luminance('rgba(0, 0, 0, 0)')).toBeNull();
    expect(luminance('rgba(0, 0, 0, 0.3)')).toBeNull();
    expect(luminance('rgba(20, 21, 24, 0.9)')).toBeLessThan(0.02);
    expect(luminance('transparent')).toBeNull();
  });

  it('nextAd：> 55% 变深、< 45% 变浅，中间保持（防抖）', () => {
    expect(nextAd(AD_ON + 0.01, false)).toBe(true);
    expect(nextAd(0.5, false)).toBe(false);
    expect(nextAd(0.5, true)).toBe(true);
    expect(nextAd(AD_OFF - 0.01, true)).toBe(false);
  });

  it('isDarkEl：背景色深的算；背景是深色渐变的也算；没背景的不算', () => {
    const a = document.createElement('div');
    a.style.backgroundColor = 'rgb(30, 31, 36)';
    const b = document.createElement('div');
    b.style.backgroundImage = 'linear-gradient(135deg, rgb(60, 54, 23), rgb(30, 32, 39))';
    const c = document.createElement('div');
    document.body.append(a, b, c);
    expect(isDarkEl(a)).toBe(true);
    expect(isDarkEl(b)).toBe(true);
    expect(isDarkEl(c)).toBe(false);
    a.remove();
    b.remove();
    c.remove();
  });

  it('makeCopy：去掉 id、testid、data-ghost、tabindex、链接 href；输入框和按钮禁用；绝对定位、抄字色', () => {
    const src = document.createElement('li');
    src.id = 'x';
    src.dataset['ghost'] = '';
    src.dataset['testid'] = 'row';
    src.style.color = 'rgb(1, 2, 3)';
    src.append(h('a', { href: '#/todo/1', id: 'y', 'data-testid': 'link', tabindex: '0' }, '交报告'), h('button', {}, '完成'), h('input', { value: '1' }));
    document.body.append(src);
    const c = makeCopy(src);
    for (const a of ['id', 'data-testid', 'data-ghost', 'tabindex', 'href']) expect(attrNames(c)).not.toContain(a);
    expect((c.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect((c.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(c.style.position).toBe('absolute');
    expect(c.style.color).toBe('rgb(1, 2, 3)');
    expect(c.textContent).toBe('交报告完成');
    src.remove();
  });

  it('makeCopy：去掉 name、form、id（代码复查 L5）；同名单选框的副本放进文档，原件的选中不被挤掉，副本也不归到原表单', () => {
    const form = h('form', { id: 'f' });
    const src = document.createElement('div');
    src.append(h('input', { type: 'radio', name: 'p', value: 'a', id: 'ra' }), h('input', { type: 'radio', name: 'p', value: 'b', form: 'f' }));
    document.body.append(form, src);
    const [ra, rb] = [...src.querySelectorAll('input')] as HTMLInputElement[];
    (rb as HTMLInputElement).checked = true;
    (ra as HTMLInputElement).checked = true; // 同名 p、没有表单的这一个选中
    const c = makeCopy(src);
    for (const a of ['name', 'form', 'id']) expect(attrNames(c)).not.toContain(a);
    document.body.append(c);
    expect((ra as HTMLInputElement).checked).toBe(true); // 副本里那个也是选中的，但不同组，原件不被挤掉
    expect((c.querySelector('input') as HTMLInputElement).form).toBeNull();
    expect([...(form as HTMLFormElement).elements]).toEqual([rb]); // 副本没归到 #f
    c.remove();
    src.remove();
    form.remove();
  });
});

// IntersectionObserver 替身：observe 记下来，测试里手动宣布“进了底部那一段”
let ioCb: ((es: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
const observed = new Set<Element>();
class FakeIO {
  constructor(cb: typeof ioCb) {
    ioCb = cb;
  }
  observe(el: Element): void {
    observed.add(el);
  }
  disconnect(): void {
    observed.clear();
  }
}
const rect = (left: number, top: number, w: number, h: number): DOMRect =>
  ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

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
  let main: HTMLElement;
  let row: HTMLElement;
  let vaultRow: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
      frames.push(f);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    document.body.replaceChildren(
      h('main', {}, h('ul', {}, h('li', { 'data-ghost': '', id: 'r1', 'data-testid': 'row1' }, '交报告')), h('section', { 'data-private': '' }, h('p', { 'data-ghost': '' }, '密'))),
      h('nav'),
      h('aside', { 'data-ghost': '', id: 'outside' }, '页面外面'),
    );
    main = document.querySelector('main') as HTMLElement;
    row = document.getElementById('r1') as HTMLElement;
    vaultRow = main.querySelector('[data-private] p') as HTMLElement;
    nav = document.querySelector('nav') as HTMLElement;
    nav.getBoundingClientRect = () => rect(14, 700, 300, 62);
    row.getBoundingClientRect = () => rect(16, 690, 340, 50);
    vaultRow.getBoundingClientRect = () => rect(16, 690, 340, 50);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-rt');
    frames = [];
  });

  it('只观察 main 里的 data-ghost；进了底部那一段、和底栏相交的建副本：副本层 aria-hidden + inert，副本没有 testid、按位置平移', () => {
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    expect([...observed]).toEqual(expect.arrayContaining([row, vaultRow]));
    expect(observed.has(document.getElementById('outside') as HTMLElement)).toBe(false); // main 外面的不看
    ioCb?.([{ target: row, isIntersecting: true }, { target: vaultRow, isIntersecting: true }]);
    runFrames();
    const layer = nav.querySelector('[data-glass-layer]') as HTMLElement;
    expect(layer).not.toBeNull();
    expect(nav.firstElementChild).toBe(layer); // 在玻璃块最底下
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.inert).toBe(true);
    expect(layer.style.filter).toBe('var(--g-copy-fx)');
    expect(nav.dataset['glass']).toBe('copy');
    expect(layer.children.length).toBe(1); // 隐私记那一条不建
    const copy = layer.children[0] as HTMLElement;
    expect(copy.textContent).toBe('交报告');
    expect(copy.getAttribute('data-testid')).toBeNull();
    expect(copy.style.transform).toBe('translate(2px, -10px)');
    expect(document.querySelectorAll('[data-testid="row1"]').length).toBe(1);
    g.stop();
    expect(nav.querySelector('[data-glass-layer]')).toBeNull();
    expect(nav.dataset['glass']).toBeUndefined();
  });

  it('滚出底栏：副本删掉；离开底部那一段：候选去掉', () => {
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    ioCb?.([{ target: row, isIntersecting: true }]);
    runFrames();
    expect(nav.querySelector('[data-glass-layer]')?.children.length).toBe(1);
    row.getBoundingClientRect = () => rect(16, 500, 340, 50);
    g.poke();
    runFrames();
    expect(nav.querySelector('[data-glass-layer]')?.children.length).toBe(0);
    row.getBoundingClientRect = () => rect(16, 690, 340, 50);
    ioCb?.([{ target: row, isIntersecting: false }]);
    runFrames();
    expect(nav.querySelector('[data-glass-layer]')?.children.length).toBe(0);
    g.stop();
  });

  it('液滴用 --g-drop-fx', () => {
    const drop = document.createElement('span');
    nav.append(drop);
    drop.getBoundingClientRect = () => rect(20, 705, 70, 52);
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }, { el: drop, fx: 'drop' }], adTarget: nav });
    runFrames();
    expect((drop.querySelector('[data-glass-layer]') as HTMLElement).style.filter).toBe('var(--g-drop-fx)');
    g.stop();
  });

  it('自动深浅：深色内容盖住底栏大半时 data-ad="dark"，挪开换回', () => {
    row.style.backgroundColor = 'rgb(30, 31, 36)';
    row.getBoundingClientRect = () => rect(14, 700, 300, 62); // 整个盖住
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    ioCb?.([{ target: row, isIntersecting: true }]);
    runFrames();
    expect(nav.dataset['ad']).toBe('dark');
    row.getBoundingClientRect = () => rect(14, 700, 300, 20); // 只盖住 1/3
    g.poke();
    runFrames();
    expect(nav.dataset['ad']).toBeUndefined();
    g.stop();
  });

  it('减少透明效果（:root[data-rt="1"]）：不建副本层、不写 data-glass', () => {
    document.documentElement.dataset['rt'] = '1';
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    ioCb?.([{ target: row, isIntersecting: true }]);
    runFrames();
    expect(nav.querySelector('[data-glass-layer]')).toBeNull();
    expect(nav.dataset['glass']).toBeUndefined();
    g.stop();
  });

  it('帧循环只在有事时跑：一次 poke 跑完就停（没有一直排着下一帧）', () => {
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    runFrames(1);
    expect(frames.length).toBe(0);
    g.poke();
    expect(frames.length).toBe(1);
    g.stop();
  });

  it('页面内容变了：新加的 data-ghost 也观察，副本重做；玻璃块自己里的变化不算', async () => {
    const g = startGlass({ pieces: [{ el: nav, fx: 'copy' }], adTarget: nav });
    ioCb?.([{ target: row, isIntersecting: true }]);
    runFrames();
    const before = nav.querySelector('[data-glass-layer]')?.children[0];
    const li = document.createElement('li');
    li.dataset['ghost'] = '';
    main.querySelector('ul')?.append(li);
    await Promise.resolve();
    expect(observed.has(li)).toBe(true);
    runFrames();
    const after = nav.querySelector('[data-glass-layer]')?.children[0];
    expect(after).not.toBe(before);
    // 玻璃块里加东西（液滴重挂这类）：不清副本
    nav.append(document.createElement('span'));
    await Promise.resolve();
    runFrames();
    expect(nav.querySelector('[data-glass-layer]')?.children[0]).toBe(after);
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
