// 页面切换的 View Transitions 接令牌（架构 17.2 第 1、3 点，17.3；UI-4 L-3，B1）：
// base.css 里 ::view-transition-old/new(root) 用 --dur-sheet + --ease-standard，不是浏览器默认的 0.25s ease；
// 减少动态效果时 transition() 直接切换、不起 View Transition（所以 CSS 这一侧不用再写覆盖）；TC-B1-51 的两条路见 navigate.test.tsx
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transition } from '../index.ts';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'styles', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 选择器列表里含 sel 的所有规则块里的声明，按出现顺序合并（后面的盖前面的，和层叠一致） */
function declsOf(sel: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? '').split(',').map((s) => s.trim());
    if (!sels.includes(sel)) continue;
    for (const d of (m[2] ?? '').split(';')) {
      const [k, v] = d.split(':').map((x) => x.trim());
      if (k && v !== undefined) out.set(k, v);
    }
  }
  return out;
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

// 负责人 10-31（iPhone 主屏幕版）：设置 ↔ 注销账号切换时“注销账号”四个字跳一下——整页交叉淡入淡出时，居中的旧标题“设置”叠在新标题中间。
// 顶栏单独起名 page-head（SettingsPage.module.css 的 .top）：两边都有顶栏时先淡出、再淡入；只有一边有（今天 ↔ 设置）时和整页同步
describe('页面顶栏 page-head：两边都有时先出后入，不叠在一起', () => {
  /** @keyframes name 里每个关键帧选择器 → opacity */
  function frames(name: string): Map<string, string> {
    const at = css.indexOf(`@keyframes ${name} {`);
    expect(at, `有 @keyframes ${name}`).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}\n}', at) + 3);
    const out = new Map<string, string>();
    for (const m of body.matchAll(/([\w%,\s]+)\{\s*opacity:\s*([\d.]+);\s*\}/g)) {
      for (const k of (m[1] ?? '').split(',')) out.set(k.trim(), m[2] ?? '');
    }
    return out;
  }

  it('时长、曲线和整页一样（--dur-sheet、--ease-standard，A24 只准令牌）；不写 delay，先后靠关键帧', () => {
    for (const sel of ['::view-transition-old(page-head)', '::view-transition-new(page-head)']) {
      const d = declsOf(sel);
      expect(d.get('animation-duration'), sel).toBe('var(--dur-sheet)');
      expect(d.get('animation-timing-function'), sel).toBe('var(--ease-standard)');
      expect(d.has('animation-delay'), sel).toBe(false);
    }
  });

  it('两边都有：旧的 lemo-head-out 前 40% 淡完，新的 lemo-head-in 40% 以后才淡入（同一时刻不会两个都看得见）', () => {
    expect(declsOf('::view-transition-old(page-head)').get('animation-name')).toBe('lemo-head-out');
    expect(declsOf('::view-transition-new(page-head)').get('animation-name')).toBe('lemo-head-in');
    const out = frames('lemo-head-out');
    const inn = frames('lemo-head-in');
    expect(Object.fromEntries(out)).toEqual({ '0%': '1', '40%': '0', '100%': '0' });
    expect(Object.fromEntries(inn)).toEqual({ '0%': '0', '40%': '0', '100%': '1' });
  });

  it('只有一边有顶栏（:only-child，今天 ↔ 设置）：换回整段淡出 / 淡入，和整页同步', () => {
    expect(declsOf('::view-transition-old(page-head):only-child').get('animation-name')).toBe('lemo-fade-out');
    expect(declsOf('::view-transition-new(page-head):only-child').get('animation-name')).toBe('lemo-fade-in');
    expect(Object.fromEntries(frames('lemo-fade-out'))).toEqual({ to: '0' });
    expect(Object.fromEntries(frames('lemo-fade-in'))).toEqual({ from: '0' });
  });

  it('顶栏的组不滑位置（animation: none）：往下滚过再进注销页时新旧顶栏位置不同，默认 0.25s 滑过去会再动一下', () => {
    expect(declsOf('::view-transition-group(page-head)').get('animation')).toBe('none');
  });

  it('不用 :not(:only-child)：Chromium 不认，整条规则会被丢掉、退回叠着淡入淡出', () => {
    expect(css).not.toContain(':not(:only-child)');
  });
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

// 接手清单 M4 剩余：::view-transition-group(*) 接令牌（第一个具名共享元素上线前）
describe('具名共享元素的组接令牌（M4）', () => {
  it('::view-transition-group(*)：--dur-sheet + --ease-standard；page-head 的组仍是 animation: none', () => {
    const d = declsOf('::view-transition-group(*)');
    expect(d.get('animation-duration')).toBe('var(--dur-sheet)');
    expect(d.get('animation-timing-function')).toBe('var(--ease-standard)');
    expect(declsOf('::view-transition-group(page-head)').get('animation')).toBe('none');
    // page-head 的规则写在 (*) 后面：就算哪个浏览器把两者算成同一优先级，后写的也赢
    expect(css.indexOf('::view-transition-group(page-head)')).toBeGreaterThan(css.indexOf('::view-transition-group(*)'));
  });
});

// 建测试按钮（A22 不准 innerHTML）：[文字, 是否 Pressable, data-state]
function setButtons(spec: readonly (readonly [string, boolean, string?])[]): void {
  document.body.replaceChildren(
    ...spec.map(([text, pressable, state]) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (pressable) b.setAttribute('data-pressable', '');
      if (state) b.setAttribute('data-state', state);
      return b;
    }),
  );
}

// UI-4 B1 动效确认 C3（X-3）：切页前所有 Pressable 瞬间复位，旧画面不截到缩着的按钮
describe('transition()：起 View Transition 前给 Pressable 打 data-snap，回调里摘掉（C3）', () => {
  const doc = document as unknown as { startViewTransition?: unknown };

  afterEach(() => {
    delete doc.startViewTransition;
    document.body.replaceChildren();
  });

  it('截旧画面那一刻（startViewTransition 被调用时）所有 Pressable 都带 data-snap；回调一进来就摘掉，再执行 update', async () => {
    setButtons([['a', true, 'idle'], ['b', true, 'pressed'], ['c', false]]);
    const atStart: string[] = [];
    const inUpdate: number[] = [];
    doc.startViewTransition = vi.fn((cb: () => void) => {
      for (const b of document.querySelectorAll('button')) atStart.push(`${b.textContent}:${b.hasAttribute('data-snap')}`);
      cb();
      return { finished: Promise.resolve() };
    });
    await transition(() => inUpdate.push(document.querySelectorAll('[data-snap]').length));
    expect(atStart).toEqual(['a:true', 'b:true', 'c:false']);
    expect(inUpdate).toEqual([0]);
    expect(document.querySelectorAll('[data-snap]')).toHaveLength(0);
  });

  it('startViewTransition 同步抛错：摘掉 data-snap、照样画新页面（代码审查 S2）', async () => {
    setButtons([['a', true, 'idle']]);
    doc.startViewTransition = vi.fn(() => {
      throw new Error('boom');
    });
    let ran = 0;
    await transition(() => {
      ran++;
    });
    expect(ran).toBe(1);
    expect(document.querySelectorAll('[data-snap]')).toHaveLength(0);
  });

  it('不起 View Transition 时（不支持或减少动态效果）不打标记', async () => {
    setButtons([['a', true, 'idle']]);
    let seen = -1;
    await transition(() => {
      seen = document.querySelectorAll('[data-snap]').length;
    });
    expect(seen).toBe(0);
  });
});
