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

  it('开发版：切页回调里新页面画完就查，重名在控制台报错；不重名不报', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    };
    await transition(() => add('i', { name: 'vt-plus' }));
    expect(err).not.toHaveBeenCalled();
    await transition(() => add('b', { name: 'vt-plus' }));
    expect(err).toHaveBeenCalledWith('[vt] duplicate view-transition-name: vt-plus');
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
