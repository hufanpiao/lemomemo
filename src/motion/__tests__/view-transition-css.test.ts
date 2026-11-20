// 页面切换的 View Transitions 接令牌（架构 17.2 第 1、3 点，17.3；UI-4 L-3，B1）：
// base.css 里 ::view-transition-old/new(root) 用 --dur-sheet + --ease-drawer（11-20 起滑动推页），不是浏览器默认的 0.25s ease；
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
    it(`${sel}：时长 --dur-sheet，曲线 --ease-drawer（iOS 推页），不叠加混合`, () => {
      const d = declsOf(sel);
      expect(d.get('animation-duration')).toBe('var(--dur-sheet)');
      expect(d.get('animation-timing-function')).toBe('var(--ease-drawer)');
      expect(d.get('mix-blend-mode')).toBe('normal');
    });
  }
});

/** @keyframes name 里每个关键帧选择器 → 声明 */
function frames(name: string): Map<string, string> {
  const at = css.indexOf(`@keyframes ${name} {`);
  expect(at, `有 @keyframes ${name}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf('}\n}', at) + 3);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/([\w%,\s]+)\{([^{}]*)\}/g)) {
    for (const k of (m[1] ?? '').split(',')) out.set(k.trim(), (m[2] ?? '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

// 负责人 11-20：“所有点击进入下一页，比如待办编辑，比如设置页，比如设置里面的2级页面的时候画面都黑一下”，选“新页从右滑进盖住”。
// 原来先出后入（旧页前 40% 淡完、新页 35% 以后才淡入），中间两页都看不见，露出底色
describe('整页 root：进页新页从右滑进盖住，返回反过来；任何一帧都有页面在屏上', () => {
  it('进页：旧页 lemo-push-old 往左退 30vw，新页 lemo-push-new 从 100vw 滑进来；不再淡（没有 opacity）', () => {
    expect(declsOf('::view-transition-old(root)').get('animation-name')).toBe('lemo-push-old');
    expect(declsOf('::view-transition-new(root)').get('animation-name')).toBe('lemo-push-new');
    expect(Object.fromEntries(frames('lemo-push-old'))).toEqual({ to: 'transform: translateX(-30vw);' });
    expect(Object.fromEntries(frames('lemo-push-new'))).toEqual({ from: 'transform: translateX(100vw);' });
  });

  it('返回（<html data-vt-back>）：旧页 lemo-pop-old 往右滑出、压在上一页上面，上一页 lemo-pop-new 从 -30vw 回来', () => {
    expect(declsOf(':root[data-vt-back]::view-transition-old(root)').get('animation-name')).toBe('lemo-pop-old');
    expect(declsOf(':root[data-vt-back]::view-transition-old(root)').get('z-index')).toBe('1');
    expect(declsOf(':root[data-vt-back]::view-transition-new(root)').get('animation-name')).toBe('lemo-pop-new');
    expect(Object.fromEntries(frames('lemo-pop-old'))).toEqual({ to: 'transform: translateX(100vw);' });
    expect(Object.fromEntries(frames('lemo-pop-new'))).toEqual({ from: 'transform: translateX(-30vw);' });
  });

  it('旧的先出后入关键帧、顶栏单独起名 page-head 都删了（顶栏跟整页一起截、一起滑，新页才盖得住旧顶栏）', () => {
    expect(css).not.toMatch(/lemo-head-(in|out)/);
    expect(css).not.toContain('page-head');
  });

  it('减少动态效果：覆盖写在 <html> 自己身上（不带空格）、进页返回都有、写 animation: none；带空格的后代写法永远匹配不上，不许出现（独立评审 11-20 第 3 条）', () => {
    for (const sel of ['::view-transition-old(root)', '::view-transition-new(root)', '[data-vt-back]::view-transition-old(root)', '[data-vt-back]::view-transition-new(tabbar):only-child']) {
      expect(declsOf(`:root[data-rm="1"]${sel}`).get('animation'), sel).toBe('none');
    }
    expect(css).not.toMatch(/:root\[data-rm="1"\]\s+(::view-transition|:root)/);
  });

  it('不用 :not(:only-child)：Chromium 不认，整条规则会被丢掉', () => {
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

  it('系统设置了 reduce 但 data-rm 没写：不自己查 matchMedia，照常走 View Transition（系统设置由 look.ts 并进 data-rm）', async () => {
    const start = stubVt();
    const mm = vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('matchMedia', mm);
    try {
      await transition(vi.fn());
      expect(start).toHaveBeenCalledOnce();
      expect(mm).not.toHaveBeenCalled();
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
  it('::view-transition-group(*)：--dur-sheet + --ease-standard', () => {
    const d = declsOf('::view-transition-group(*)');
    expect(d.get('animation-duration')).toBe('var(--dur-sheet)');
    expect(d.get('animation-timing-function')).toBe('var(--ease-standard)');
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

// 11-06 代码审查 S4：iOS 18.0～18.1 不认 :active-view-transition，底栏“过渡中换实色”还认 <html data-vt>
describe('transition()：过渡期间 <html> 带 data-vt', () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  const has = () => document.documentElement.hasAttribute('data-vt');
  afterEach(() => {
    delete doc.startViewTransition;
  });

  it('调用 startViewTransition 之前就打上（旧画面在调用之后才截），finished 以后摘掉', async () => {
    let seen = false;
    let end: () => void = () => undefined;
    doc.startViewTransition = (cb: () => void) => {
      seen = has();
      cb();
      return { finished: new Promise<void>((r) => (end = r)) };
    };
    const p = transition(() => undefined);
    expect(seen).toBe(true);
    expect(has()).toBe(true);
    end();
    await p;
    expect(has()).toBe(false);
  });

  // 代码审查 L10：过渡被跳过或中止时 finished 会 reject，也要摘掉，transition() 照样 resolve
  it('finished 被 reject：照样摘掉 data-vt，transition() 不往外抛', async () => {
    let fail: (e: Error) => void = () => undefined;
    doc.startViewTransition = (cb: () => void) => {
      cb();
      return { finished: new Promise<void>((_, rej) => (fail = rej)) };
    };
    const p = transition(() => undefined);
    expect(has()).toBe(true);
    fail(new Error('skipped'));
    await expect(p).resolves.toBeUndefined();
    expect(has()).toBe(false);
  });

  it('新过渡打断旧过渡：旧的先结束时还留着，最后一个结束才摘；同步抛错也摘', async () => {
    const ends: Array<() => void> = [];
    doc.startViewTransition = (cb: () => void) => {
      cb();
      return { finished: new Promise<void>((r) => ends.push(r)) };
    };
    const a = transition(() => undefined);
    const b = transition(() => undefined);
    ends[0]?.();
    await a;
    expect(has()).toBe(true);
    ends[1]?.();
    await b;
    expect(has()).toBe(false);
    doc.startViewTransition = () => {
      throw new Error('boom');
    };
    await transition(() => undefined);
    expect(has()).toBe(false);
  });
});

// 负责人 11-06 真机 9d40848：过渡中底栏不换实色、全程玻璃；iOS 把带 backdrop-filter 的元素按直角截快照，组上裁圆角；只画旧的那份（液滴不叠两颗）
describe('底栏和“＋”的快照：圆角和阴影画在快照自己身上，只有一边有底栏时不剩空阴影壳（代码审查 M5）', () => {
  it('组上不再画阴影、不裁：只有一边有底栏时组上的阴影会剩一个空壳', () => {
    expect(css).not.toMatch(/::view-transition-group\(tabbar(-add)?\) \{[^}]*(box-shadow|overflow)/);
  });
  it('旧快照和只有新那份时的新快照：overflow: clip + 圆角 + 补阴影；“＋”连底色圈和细灰边；宽屏侧栏 --r-xl + --b-rail-shadow', () => {
    expect(css).toMatch(/::view-transition-old\(tabbar\),\s*::view-transition-new\(tabbar\):only-child \{\s*overflow: clip;\s*border-radius: var\(--r-pill\);\s*box-shadow: var\(--g-bar-shadow\);/);
    expect(css).toMatch(
      /::view-transition-old\(tabbar-add\),\s*::view-transition-new\(tabbar-add\):only-child \{\s*overflow: clip;\s*border-radius: 50%;\s*box-shadow: 0 0 0 4px var\(--bg\), 0 0 0 5px var\(--step-off\), var\(--g-bar-shadow\);/,
    );
    expect(css).toMatch(/@media \(width >= 900px\) \{\s*::view-transition-old\(tabbar\),\s*::view-transition-new\(tabbar\):only-child \{\s*border-radius: var\(--r-xl\);\s*box-shadow: var\(--b-rail-shadow\);/);
  });
  it('两边都有时新的那份 opacity 0、旧的照画；只有新的那份时照样画（opacity 1）', () => {
    expect(declsOf('::view-transition-new(tabbar)').get('opacity')).toBe('0');
    expect(declsOf('::view-transition-new(tabbar-add)').get('opacity')).toBe('0');
    expect(css).toMatch(/::view-transition-new\(tabbar\):only-child,\s*::view-transition-new\(tabbar-add\):only-child \{\s*opacity: 1;/);
    expect(declsOf('::view-transition-old(tabbar)').has('opacity')).toBe(false);
  });

  it('只有一边有底栏（进出新建页、设置）：跟着自己那一页滑；画在整页上面盖不住的那两种边滑边淡；两边都有时照旧 animation: none', () => {
    for (const n of ['tabbar', 'tabbar-add']) {
      const oldOnly = declsOf(`::view-transition-old(${n}):only-child`);
      // 进页：旧页的底栏跟着往左退、前 40% 淡完（新页盖不住它）
      expect(oldOnly.get('animation-name')).toBe('lemo-push-old-fade');
      expect(oldOnly.get('animation-duration')).toBe('var(--dur-sheet)');
      expect(oldOnly.get('animation-timing-function')).toBe('var(--ease-drawer)');
      expect(declsOf(`::view-transition-new(${n}):only-child`).get('animation-name')).toBe('lemo-push-new');
      // 返回：滑走那页的底栏跟着滑出；回来那页的底栏 60% 以后才淡入（画在滑走那页上面）
      expect(declsOf(`:root[data-vt-back]::view-transition-old(${n}):only-child`).get('animation-name')).toBe('lemo-pop-old');
      expect(declsOf(`:root[data-vt-back]::view-transition-new(${n}):only-child`).get('animation-name')).toBe('lemo-pop-new-fade');
      expect(declsOf(`::view-transition-old(${n})`).get('animation')).toBe('none');
      // 组上不留抄过来的模糊：快照淡掉后不剩直角毛玻璃方块
      expect(declsOf(`::view-transition-group(${n})`).get('backdrop-filter')).toBe('none');
    }
  });
});
