// 进出二级页的整页推页（motion/page-swap.ts 的 transition）。11-20 负责人“进入2级页后退出的时候底部导航栏会模糊一下”“底栏不是固定死了吗？
// 为啥切页回来的时候还要用快照”：不再用 View Transition（底栏在过渡里是一张截图、拍不到后面的内容，放完真底栏露出来模糊才突然出现），
// 改用和页签互切同一套换页引擎，新旧页、底栏和“＋”都是真元素。这里钉住：关键帧和时长照搬原来的 lemo-push/pop 动画；等新页画完；
// 等的时候吞手指点按、不吞键盘；Pressable 复位；data-vt / data-vt-back；打断；CSS 里不再出现 View Transition
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPageSwap, transition as viaIndex } from '../index.ts';
import { cancelFade, PAGE_WAIT_MS, transition } from '../page-swap.ts';
import { bezierCss, dur, ease } from '../tokens.ts';

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
const DRAWER = bezierCss(ease.drawer);

/** 页面：body > #root > main（+ 底栏 nav、“＋”按钮，都打 data-swap-bar） */
let root: HTMLElement;
const page = (name: string, { bar = false, pending = false } = {}): HTMLElement => {
  for (const m of root.querySelectorAll('main, [data-swap-bar]')) m.remove();
  const m = document.createElement('main');
  m.dataset.feature = name;
  if (pending) {
    const mark = document.createElement('i');
    mark.setAttribute('data-page-pending', '');
    m.append(mark);
  }
  root.append(m);
  if (bar) {
    const nav = document.createElement('nav');
    nav.setAttribute('data-swap-bar', '');
    const add = document.createElement('button');
    add.setAttribute('data-swap-bar', '');
    root.append(nav, add);
  }
  return m;
};
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);
const finishAll = (): void => anims.forEach((a) => a.finish());

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
  // “显示着”的口径：jsdom 里由 tests/fakes/jsdom-layout-setup.ts 补（在文档里、自己和祖先都没有内联 display: none）
  document.body.replaceChildren();
  root = Object.assign(document.createElement('div'), { id: 'root' });
  document.body.append(root);
  document.documentElement.removeAttribute('data-rm');
});

afterEach(() => {
  cancelFade();
  vi.useRealTimers();
  delete (Element.prototype as { animate?: unknown }).animate;
});

const on = (el: Element | null | undefined): FakeAnim | undefined => anims.find((a) => a.el === el);
const translates = (a: FakeAnim | undefined): unknown[] => (a?.frames ?? []).map((k) => k.translate ?? null);

describe('关键帧、时长、曲线照搬原来的 lemo-push / lemo-pop（数值不改）', () => {
  it('进页：旧页（快照）0 → -30vw，新页从 100vw 滑到 0；--dur-sheet、--ease-drawer 写在每个关键帧上、整段 linear', async () => {
    page('today');
    const p = transition(() => page('edit'));
    const main = document.querySelector('main');
    const ghost = document.querySelector('[data-tab-ghost]');
    expect(ghost, '旧页的真 DOM 副本').not.toBeNull();
    expect(translates(on(ghost))).toEqual(['0px', '-30vw']);
    expect(translates(on(main))).toEqual(['100vw', '0px']);
    for (const a of anims) {
      expect(a.opts.duration).toBe(dur.sheet * 1000);
      expect(a.opts.easing).toBe(bezierCss(ease.linear));
      expect(a.frames[0]?.easing).toBe(DRAWER);
    }
    finishAll();
    await p;
  });

  it('返回：旧页（快照）0 → 100vw、压在回来的那页上面（挂在 #root 后面）；回来的那页从 -30vw 回到 0', async () => {
    page('edit');
    const p = transition(() => page('today'), true);
    const ghost = document.querySelector('[data-tab-ghost]');
    expect(ghost?.previousElementSibling).toBe(root);
    expect(translates(on(ghost))).toEqual(['0px', '100vw']);
    expect(translates(on(document.querySelector('main')))).toEqual(['-30vw', '0px']);
    finishAll();
    await p;
  });
});

// 负责人 11-20：底栏、“＋”全程是真元素（实时模糊），不再是截图
describe('底栏和“＋”', () => {
  it('进二级页（只有旧页有底栏）：底栏副本直接挂 body 下，跟着旧页往左退、前 40% 淡完（lemo-push-old-fade）；收尾拿掉', async () => {
    page('today', { bar: true });
    const p = transition(() => page('edit'));
    const copies = [...document.body.children].filter((e) => e.getAttribute('aria-hidden') === 'true' && (e.tagName === 'NAV' || e.tagName === 'BUTTON'));
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      expect(c.hasAttribute('data-swap-bar'), '副本不带标记，不会被当成真底栏').toBe(false);
      expect(c.hasAttribute('data-swap-bar-copy')).toBe(true);
      const f = on(c)?.frames ?? [];
      expect(f.map((k) => [k.offset, k.opacity, k.translate ?? null])).toEqual([
        [0, 1, '0px'],
        [0.4, 0, null],
        [1, 0, '-30vw'],
      ]);
    }
    finishAll();
    await p;
    for (const c of copies) expect(c.isConnected).toBe(false);
  });

  it('返回到有底栏的页：真底栏从 -30vw 跟着回来、60% 以后才淡入（lemo-pop-new-fade）', async () => {
    page('edit');
    const p = transition(() => page('today', { bar: true }), true);
    for (const b of root.querySelectorAll('[data-swap-bar]')) {
      const f = on(b)?.frames ?? [];
      expect(f.map((k) => [k.offset, k.opacity, k.translate ?? null])).toEqual([
        [0, 0, '-30vw'],
        [0.6, 0, null],
        [1, 1, '0px'],
      ]);
    }
    finishAll();
    await p;
  });

  it('两边都有底栏：底栏原地不动，副本当场拿掉', async () => {
    page('a', { bar: true });
    const p = transition(() => page('b', { bar: true }));
    for (const b of root.querySelectorAll('[data-swap-bar]')) expect(on(b)).toBeUndefined();
    expect(document.querySelectorAll('body > nav, body > button')).toHaveLength(0);
    finishAll();
    await p;
  });
});

describe('main 外面的 fixed 层（底栏实色带、提示气泡）当成页面的一部分', () => {
  it('返回时跟着回来的那页一起动，动画期间 z-index auto 压到滑走的旧页下面；滑到一半才挂上的从当前进度接着动', async () => {
    page('edit');
    const band = document.createElement('div');
    band.style.position = 'fixed';
    const p = transition(() => {
      page('today', { bar: true });
      root.append(band);
    }, true);
    const a = on(band);
    expect(translates(a)).toEqual(['-30vw', '0px']);
    expect(a?.frames.every((k) => k.zIndex === 'auto')).toBe(true);
    const lead = anims[0];
    if (lead) lead.currentTime = 123;
    const hint = document.createElement('div');
    hint.style.position = 'fixed';
    root.append(hint);
    await flush();
    expect(translates(on(hint))).toEqual(['-30vw', '0px']);
    expect(on(hint)?.currentTime).toBe(123);
    finishAll();
    await p;
  });
});

// 负责人 11-20 录屏“设置进入待办最近删除页的时候顶部闪一下”：懒加载的页第一次渲染先挂起一拍，不等就滑进一张空页
describe('等新页画完再动', () => {
  it('新页 main 没出来：屏幕停在旧页（副本显示、#root 透明），不动；main 一出来就动', async () => {
    page('today');
    const p = transition(() => {
      for (const m of root.querySelectorAll('main')) m.remove();
    });
    expect(anims).toHaveLength(0);
    expect(root.style.opacity).toBe('0');
    page('edit');
    await flush();
    expect(anims.length).toBeGreaterThan(0);
    expect(root.style.opacity, '开始动就放开').toBe('');
    finishAll();
    await p;
  });

  it('main 在、页面级懒加载块还没到（data-page-pending）：接着等；标记一去掉就动；等的时候手指点按吞掉，键盘 click（前面有 keydown）不吞', async () => {
    page('today');
    const p = transition(() => page('sub', { pending: true }));
    const btn = document.createElement('button');
    const hit = vi.fn();
    btn.addEventListener('click', hit);
    document.querySelector('main')?.append(btn);
    await flush();
    expect(anims).toHaveLength(0);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(hit, '等的时候手指、鼠标的点按吞掉').not.toHaveBeenCalled();
    // 认键盘只看 keydown（swallow-click.ts）：页面里派发、detail 0 但前面没有 keydown 的（e2e 模拟手指）照样吞
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(hit, '没有 keydown 的 detail 0 click 也吞').not.toHaveBeenCalled();
    // 真键盘：先有 keydown，再有 detail 0 的 click
    btn.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(hit, '键盘回车触发的 click 不吞').toHaveBeenCalledTimes(1);
    document.querySelector('[data-page-pending]')?.remove();
    await flush();
    expect(anims.length).toBeGreaterThan(0);
    finishAll();
    await p;
  });

  it('懒加载块一直不到：最多等 PAGE_WAIT_MS（300ms），main 在就照常动', async () => {
    vi.useFakeTimers();
    expect(PAGE_WAIT_MS).toBe(300);
    page('today');
    const p = transition(() => page('sub', { pending: true }));
    await vi.advanceTimersByTimeAsync(PAGE_WAIT_MS - 10);
    expect(anims).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(anims.length).toBeGreaterThan(0);
    finishAll();
    await p;
  });
});

describe('标记和复位', () => {
  it('整段带 data-vt，返回再带 data-vt-back，放完摘掉；Pressable 拷旧页时打 data-snap、换页前摘掉', async () => {
    page('today');
    const press = document.createElement('button');
    press.setAttribute('data-pressable', '');
    document.querySelector('main')?.append(press);
    press.setAttribute('data-state', 'pressed');
    const html = document.documentElement;
    let snapAtUpdate: boolean | null = null;
    const p = transition(() => {
      snapAtUpdate = press.hasAttribute('data-snap');
      page('edit', { bar: true });
      const back = document.createElement('button');
      back.setAttribute('data-pressable', '');
      document.querySelector('main')?.append(back);
    }, true);
    expect(snapAtUpdate, '真页面上的换页前摘掉').toBe(false);
    expect(document.querySelector('main [data-snap]'), '新页上的不带').toBeNull();
    expect(
      document.querySelector('[data-tab-ghost] [data-pressable][data-state="pressed"][data-snap]'),
      '旧页副本拷的是复位后的样子，整段都留着（摘了按下的按钮会缩回去）',
    ).not.toBeNull();
    expect(html.hasAttribute('data-vt')).toBe(true);
    expect(html.hasAttribute('data-vt-back')).toBe(true);
    finishAll();
    await p;
    expect(html.hasAttribute('data-vt')).toBe(false);
    expect(html.hasAttribute('data-vt-back')).toBe(false);
  });

  it('打断：上一次没放完又切，上一次的动画取消、副本拿掉，标记照样只剩这一次的', async () => {
    page('a');
    const p1 = transition(() => page('b'));
    const first = [...anims];
    cancelFade();
    const p2 = transition(() => page('c'), true);
    for (const a of first) expect(a.cancel).toHaveBeenCalled();
    await p1;
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(1);
    expect(document.documentElement.hasAttribute('data-vt-back')).toBe(true);
    finishAll();
    await p2;
    expect(document.querySelectorAll('[data-tab-ghost]')).toHaveLength(0);
    expect(document.documentElement.hasAttribute('data-vt')).toBe(false);
  });
});

describe('减少动态效果（motion/index.ts 的门面先判）', () => {
  afterEach(() => {
    delete document.documentElement.dataset['rm'];
    vi.unstubAllGlobals();
  });

  it('data-rm="1"：直接换页，不起动画、不拷旧页、不打 data-vt', async () => {
    await loadPageSwap();
    page('today');
    document.documentElement.dataset['rm'] = '1';
    const update = vi.fn(() => page('edit'));
    await viaIndex(update);
    expect(update).toHaveBeenCalledOnce();
    expect(anims).toHaveLength(0);
    expect(document.querySelector('[data-tab-ghost]')).toBeNull();
    expect(document.documentElement.hasAttribute('data-vt')).toBe(false);
  });

  it('系统设置了 reduce 但 data-rm 没写：不自己查 matchMedia，照常推页（系统设置由 look.ts 并进 data-rm）', async () => {
    await loadPageSwap();
    const mm = vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('matchMedia', mm);
    page('today');
    const p = viaIndex(() => page('edit'));
    expect(anims.length).toBeGreaterThan(0);
    expect(mm).not.toHaveBeenCalled();
    finishAll();
    await p;
  });
});

// 守门：View Transition 整块删掉以后不再长回来（底栏又变成截图）
describe('src 的 CSS 里不再有 View Transition', () => {
  const files = readdirSync('src', { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.css'))
    .map((d) => join(d.parentPath, d.name));
  const src = (f: string): string => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('没有 view-transition-name、::view-transition-*', () => {
    expect(files.length).toBeGreaterThan(0);
    const bad = files.filter((f) => /view-transition/.test(src(f)));
    expect(bad).toEqual([]);
  });
});
