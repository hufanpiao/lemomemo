// View Transitions 的名字（架构 17.2 第 3 点；UI4-B1-low X-5）：
// 固定名字登记在 VT_FIXED，CSS 里不准写没登记的；重名检查读计算样式（CSS Modules 起的名字也查得到）；开发版切页后自动查
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transition } from '../index.ts';
import { findDuplicateVtNames, VT_FIXED, vtName } from '../vt.ts';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  vi.restoreAllMocks();
});

/** 加一个元素：cls 是类名，name 是内联的 view-transition-name */
function add(tag: string, { cls, name }: { cls?: string; name?: string } = {}): void {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (name) el.style.setProperty('view-transition-name', name);
  document.body.append(el);
}
function css(text: string): void {
  const st = document.createElement('style');
  st.textContent = text;
  document.head.append(st);
}

describe('重名检查', () => {
  it('CSS 里起的名字（如 CSS Modules 的类）也算：两个元素都套上就报重名；只有一个不报', () => {
    css('.head { view-transition-name: page-head; }');
    add('header', { cls: 'head' });
    expect(findDuplicateVtNames(document)).toEqual([]);
    add('header', { cls: 'head' });
    expect(findDuplicateVtNames(document)).toEqual(['page-head']);
  });

  it('内联 style 的动态名字照样查；none 和没起名的不算', () => {
    const n = vtName('item', 'a1');
    add('li', { name: n });
    add('li', { name: 'none' });
    add('li', { name: 'none' });
    add('p');
    expect(findDuplicateVtNames(document)).toEqual([]);
    add('div', { name: n });
    expect(findDuplicateVtNames(document)).toEqual([n]);
  });

  it('开发版：切页回调里等新页画完就查，重名在控制台报错；不重名不报', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 新页已经显示（等新页那一步当场放行）；重名查在等完以后，所以 finished 要等回调返回的 promise
    const main = document.createElement('main');
    vi.spyOn(main, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    document.body.append(main);
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => Promise<void>) => ({ finished: cb() });
    await transition(() => add('i', { name: 'vt-plus' }));
    expect(err).not.toHaveBeenCalled();
    await transition(() => add('b', { name: 'vt-plus' }));
    expect(err).toHaveBeenCalledWith('[vt] duplicate view-transition-name: vt-plus');
  });
});

// 负责人 11-20 录屏“设置进入待办最近删除页的时候顶部闪一下”：懒加载的页第一次渲染先挂起一拍，过渡不等就截到空页
describe('transition()：等新页的 <main> 显示出来再截新图', () => {
  it('回调返回的 promise 等到 main 显示出来才完成；一直不出来最多等 VT_WAIT_MS', async () => {
    vi.useFakeTimers();
    let ret: Promise<void> | undefined;
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => Promise<void> | undefined) => {
      ret = cb();
      return { finished: Promise.resolve() };
    };
    const { VT_WAIT_MS } = await import('../index.ts');
    let ok = false;
    void transition(() => undefined);
    void ret?.then(() => (ok = true));
    await vi.advanceTimersByTimeAsync(VT_WAIT_MS - 10);
    expect(ok, '新页没出来：还在等').toBe(false);
    const main = document.createElement('main');
    vi.spyOn(main, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    document.body.append(main);
    await vi.advanceTimersByTimeAsync(1);
    expect(ok, 'main 一显示出来就截').toBe(true);

    ok = false;
    main.remove();
    void transition(() => undefined);
    void ret?.then(() => (ok = true));
    await vi.advanceTimersByTimeAsync(VT_WAIT_MS);
    expect(ok, '一直不出来：VT_WAIT_MS 后照常播').toBe(true);
    vi.useRealTimers();
  });

  it('main 在、但页面级懒加载块还没到（PagePending 的 data-page-pending 还在）：接着等；标记一去掉就截；等的时候点按吞掉', async () => {
    vi.useFakeTimers();
    let ret: Promise<void> | undefined;
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => Promise<void> | undefined) => {
      ret = cb();
      return { finished: Promise.resolve() };
    };
    const main = document.createElement('main');
    vi.spyOn(main, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const mark = document.createElement('i');
    mark.setAttribute('data-page-pending', '');
    main.append(mark);
    document.body.append(main);
    const btn = document.createElement('button');
    const hit = vi.fn();
    btn.addEventListener('click', hit);
    main.append(btn);
    let ok = false;
    void transition(() => undefined);
    void ret?.then(() => (ok = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(ok, '设置二级页这类：外层 main 在、里面还空着，不放行').toBe(false);
    btn.click();
    expect(hit, '等的时候点按吞掉').not.toHaveBeenCalled();
    mark.remove();
    await vi.advanceTimersByTimeAsync(1);
    expect(ok).toBe(true);
    btn.click();
    expect(hit, '截完以后点按照常').toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// 负责人 11-20 选“新页从右滑进盖住”：返回时 <html data-vt-back>，base.css 把滑入滑出换成反方向；过渡完就去掉，下次进页照常
describe('transition(update, back)：返回方向的标记', () => {
  it('back=true 时整段过渡带 data-vt-back，播完去掉；back 不传不带', async () => {
    let seen: boolean[] = [];
    let done: () => void = () => undefined;
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
      cb();
      seen.push(document.documentElement.hasAttribute('data-vt-back'));
      return { finished: new Promise<void>((r) => (done = r)) };
    };
    const p = transition(() => undefined, true);
    expect(seen).toEqual([true]);
    expect(document.documentElement.hasAttribute('data-vt-back')).toBe(true);
    done();
    await p;
    expect(document.documentElement.hasAttribute('data-vt-back')).toBe(false);
    seen = [];
    const q = transition(() => undefined);
    expect(seen).toEqual([false]);
    done();
    await q;
  });
});

describe('固定名字都登记在 VT_FIXED', () => {
  const files = readdirSync('src', { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.css'))
    .map((d) => join(d.parentPath, d.name));
  const fixed = new Set<string>(Object.values(VT_FIXED));
  /** 去掉注释后的 CSS（注释里提到名字不算） */
  const src = (f: string): string => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('src 的 CSS 里写的 view-transition-name 只能是登记过的名字或 none', () => {
    const used: string[] = [];
    for (const f of files) {
      for (const m of src(f).matchAll(/view-transition-name:\s*([^;}\s]+)/g)) used.push(m[1] ?? '');
    }
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((n) => n !== 'none' && !fixed.has(n))).toEqual([]);
  });

  it('::view-transition-*(名字) 里只用 root、*、登记过的名字', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of src(f).matchAll(/::view-transition-(?:group|old|new|image-pair)\(([^)]+)\)/g)) {
        const n = (m[1] ?? '').trim();
        if (n !== 'root' && n !== '*' && !fixed.has(n)) bad.push(`${f}: ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
