// 页面切换的 View Transitions 接令牌（架构 17.2 第 1、3 点，17.3；UI-4 L-3，B1）：
// base.css 里 ::view-transition-old/new(root) 用 --dur-sheet + --ease-standard，不是浏览器默认的 0.25s ease；
// 减少动态效果时 transition() 直接切换、不起 View Transition（所以 CSS 这一侧不用再写覆盖）；TC-B1-51 的两条路见 navigate.test.tsx
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transition } from '../index.ts';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'styles', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 选择器里含 sel 的规则块里的声明 */
function declsOf(sel: string): Map<string, string> {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? '').split(',').map((s) => s.trim());
    if (!sels.includes(sel)) continue;
    return new Map(
      (m[2] ?? '')
        .split(';')
        .map((d) => d.split(':').map((x) => x.trim()))
        .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== ''),
    );
  }
  return new Map();
}

describe('View Transitions 接令牌（UI-4 L-3）', () => {
  for (const sel of ['::view-transition-old(root)', '::view-transition-new(root)']) {
    it(`${sel}：时长 --dur-sheet，曲线 --ease-standard`, () => {
      const d = declsOf(sel);
      expect(d.get('animation-duration')).toBe('var(--dur-sheet)');
      expect(d.get('animation-timing-function')).toBe('var(--ease-standard)');
    });
  }
});

describe('transition()：减少动态效果时不起 View Transition', () => {
  // 先转成 unknown：DOM 类型里 startViewTransition 是必有的，和 Document 交叉后不能 delete、也不能装假函数
  const doc = document as unknown as { startViewTransition?: unknown };

  afterEach(() => {
    delete doc.startViewTransition;
    delete document.documentElement.dataset['rm'];
  });

  function stubVt() {
    const start = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    doc.startViewTransition = start;
    return start;
  }

  it('data-rm="1"：直接切换', async () => {
    const start = stubVt();
    document.documentElement.dataset['rm'] = '1';
    const update = vi.fn();
    await transition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('系统设置 prefers-reduced-motion: reduce（matchMedia 返回 matches）：直接切换', async () => {
    const start = stubVt();
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion: reduce'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    try {
      const update = vi.fn();
      await transition(update);
      expect(update).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('都没开：走 View Transition（对照）', async () => {
    const start = stubVt();
    const update = vi.fn();
    await transition(update);
    expect(start).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });
});
