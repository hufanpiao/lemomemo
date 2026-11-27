// 电脑上的滚动条浮出（motion/scrollbar-reveal.ts）：装上给 html 打 data-sb；哪块在滚哪块带 data-sb-on，停下 HIDE_MS 后摘掉；卸载全清
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDE_MS, installScrollbarReveal } from '../scrollbar-reveal.ts';

describe('installScrollbarReveal', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('装上给 html 打 data-sb，卸载摘掉', () => {
    off = installScrollbarReveal();
    expect(document.documentElement.hasAttribute('data-sb')).toBe(true);
    off();
    off = null;
    expect(document.documentElement.hasAttribute('data-sb')).toBe(false);
  });

  it('只有在滚的那块带 data-sb-on，连续滚动一直带着，停下 HIDE_MS 后摘掉', () => {
    vi.useFakeTimers();
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    off = installScrollbarReveal();

    a.dispatchEvent(new Event('scroll'));
    expect(a.hasAttribute('data-sb-on')).toBe(true);
    expect(b.hasAttribute('data-sb-on')).toBe(false);

    vi.advanceTimersByTime(HIDE_MS - 100);
    a.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(HIDE_MS - 100);
    expect(a.hasAttribute('data-sb-on')).toBe(true);

    vi.advanceTimersByTime(100);
    expect(a.hasAttribute('data-sb-on')).toBe(false);
  });

  it('整页滚动记在 scrollingElement 上；卸载时清掉还没到点的', () => {
    vi.useFakeTimers();
    off = installScrollbarReveal();
    document.dispatchEvent(new Event('scroll'));
    const page = document.scrollingElement ?? document.documentElement;
    expect(page.hasAttribute('data-sb-on')).toBe(true);
    off();
    off = null;
    expect(page.hasAttribute('data-sb-on')).toBe(false);
  });
});

// Chromium 121+ 元素上设了 scrollbar-width / scrollbar-color（none 以外）就不认 ::-webkit-scrollbar，
// 柠檬黄细条会变回系统灰条（11-26 网页版今天页卡片 scrollbar-width: thin）。滚动条外观只在 base.css 管，组件只许写 none（藏起来）
describe('组件不自己设滚动条外观', () => {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.css') ? [join(d, e.name)] : []));
  it('src 下除 base.css 外，scrollbar-width 只能是 none，不许写 scrollbar-color', () => {
    const bad = walk('src')
      .filter((f) => !f.replaceAll('\\', '/').endsWith('src/styles/base.css'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((l, i) => [l.trim(), i + 1] as const)
          .filter(([l]) => /^scrollbar-color\s*:/.test(l) || (/^scrollbar-width\s*:/.test(l) && !/:\s*none\s*;?$/.test(l)))
          .map(([l, n]) => `${f}:${n} ${l}`),
      );
    expect(bad).toEqual([]);
  });
});
