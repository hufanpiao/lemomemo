// 治“少一截”的四套各自单独关（11-20 负责人选“手机上对照一次”，vh-gapfix-gate.ts 的 GapPart）：early 早试垫块、bar 等底栏后那次、kb 收键盘后那次、
// css 贴底元素补 --vh-gap。每个开关关掉时只停那一套、照样量并记日志（skip part-off / off would=），另外三套照常；四个都开时和改前一样。
// 日志：gapfix start 行 sw= 记四个开关；各套生效时记量到的 gap，撤垫块那行记 gap-after（整屏 − innerHeight）
import { describe, expect, it, vi } from 'vitest';
import { createKeyboardWatcher } from '../viewport.ts';
import { GAP_VAR } from '../viewport-geom.ts';
import { startGapFix } from '../vh-gapfix.ts';
import { GAP_PARTS, gapFixOn, OFF_KEY, setGapFixOn, startEarlyGapFix, type GapPart } from '../vh-gapfix-gate.ts';
import { coldThenKeyboard, deps, frames, input, mockScroll, mountBar, pad, readGapFixLog, resize, setInner, settle, startKb } from './gapfix-fixture.ts';

const off = (part: GapPart): void => setGapFixOn(false, undefined, part);

describe('开关本身', () => {
  it('四个各存各的键（lemo-gapfix-off-<名>），默认全开；关一个不动整体开关和另外三个，再开回删掉', () => {
    expect(GAP_PARTS).toEqual(['early', 'bar', 'kb', 'css']);
    for (const p of GAP_PARTS) {
      expect(gapFixOn(undefined, p)).toBe(true);
      off(p);
      expect(localStorage.getItem(`${OFF_KEY}-${p}`)).toBe('1');
      expect(gapFixOn(undefined, p)).toBe(false);
      expect(gapFixOn()).toBe(true);
      for (const q of GAP_PARTS) if (q !== p) expect(gapFixOn(undefined, q)).toBe(true);
      setGapFixOn(true, undefined, p);
      expect(localStorage.length).toBe(0);
    }
  });

  it('gapfix start 行 sw= 照实记四个开关（early bar kb css 四位，默认 1111）', () => {
    const f = frames();
    startGapFix(f.frame, deps({ early: () => null }));
    expect(readGapFixLog()).toMatch(/^gapfix start nav=\d+ms screen=440x956 sw=1111$/m);
    off('kb');
    off('css');
    startGapFix(f.frame, deps({ early: () => null }));
    expect(readGapFixLog()).toMatch(/ sw=1100$/m);
  });
});

describe('early 关：只停早试', () => {
  it('不放垫块，记 skip part-off 和量到的 gap；别的开关关着不影响早试', () => {
    off('early');
    const f = frames();
    const e = startEarlyGapFix(f.frame, window, () => 0, () => 61);
    expect(pad()).toBeNull();
    expect(e.done).toBe(true);
    expect(e.what).toBe('skip part-off gap=61 top=61');
    expect(f.size).toBe(0);
    setGapFixOn(true, undefined, 'early');
    for (const p of ['bar', 'kb', 'css'] as const) off(p);
    const e2 = startEarlyGapFix(f.frame, window, () => 0, () => 61);
    expect(pad()).not.toBeNull();
    setInner(956);
    f.flush();
    expect(e2.what).toBe('changed 895->956 after=0ms gap=61 top=61 gap-after=0');
  });

  it('本来就不用做（没少）时照记真原因，不记 off', () => {
    off('early');
    setInner(956);
    expect(startEarlyGapFix(frames().frame, window, () => 0, () => 61).what).toBe('skip no-gap(0) gap=0 top=61');
  });

  it('early 关着，等底栏后那次照样做', () => {
    off('early');
    const f = frames();
    const e = startEarlyGapFix(f.frame, window, () => 0, () => 61);
    mountBar();
    startGapFix(f.frame, deps({ early: () => e }));
    expect(readGapFixLog()).toMatch(/early nav=0ms skip part-off gap=61 top=61/);
    expect(pad()).not.toBeNull();
    expect(readGapFixLog()).toMatch(/pad gap=61 top=61/);
  });
});

describe('bar 关：只停等底栏后那次', () => {
  it('不放垫块，记 skip part-off gap=；收键盘那次照样做', () => {
    off('bar');
    mockScroll();
    const f = frames();
    mountBar();
    startKb(f.frame, { early: () => null });
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/skip part-off gap=61 top=61 inner=895/);
    expect(readGapFixLog()).not.toMatch(/pad gap/);
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    settle();
    expect(pad()).not.toBeNull();
    expect(readGapFixLog()).toMatch(/kb pad gap=61 top=61/);
  });
});

describe('kb 关：只停收键盘后那次', () => {
  it('冷启动那次照做；键盘真收了时记 kb skip part-off gap=、不放垫块', () => {
    off('kb');
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    expect(pad()).toBeNull();
    const log = readGapFixLog();
    expect(log).toMatch(/kb skip part-off gap=61 top=61/);
    expect(log).not.toMatch(/kb pad/);
  });
});

describe('css 关：只停 --vh-gap', () => {
  /** 主屏幕版 iPhone 冷启动少一截（895 / 956），然后弹键盘、收起；记下根节点每次写了什么 */
  const run = (css: boolean): { gapCalls: unknown[][]; attrs: string[] } => {
    const handlers = new Map<string, () => void>();
    let inner = 895;
    let editing = false;
    const vv = {
      height: 895,
      offsetTop: 0,
      scale: 1,
      addEventListener: (k: string, fn: () => void) => handlers.set(k, fn),
      removeEventListener: (k: string) => handlers.delete(k),
    };
    const attrs: string[] = [];
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const root = { style, setAttribute: (k: string) => attrs.push(`+${k}`), removeAttribute: (k: string) => attrs.push(`-${k}`) };
    const w = createKeyboardWatcher({
      vv: () => vv as never,
      innerHeight: () => inner,
      root: () => root,
      doc: () => null,
      standalone: () => true,
      editing: () => editing,
      full: () => 956,
      phone: () => true,
      now: () => 0,
      cssGap: () => css,
    });
    const set = (h: number): void => {
      inner = h;
      vv.height = h;
      handlers.get('resize')?.();
    };
    const stop = w.watch(() => undefined);
    editing = true;
    set(542);
    editing = false;
    set(895);
    set(956);
    stop();
    const gapCalls = [...style.setProperty.mock.calls, ...style.removeProperty.mock.calls].filter((c) => c[0] === GAP_VAR);
    return { gapCalls, attrs };
  };

  it('开着：写 --vh-gap 61px，记 gapfix css set=61 short=61；关着：根节点一次 --vh-gap 都不写，记 off would=61', () => {
    const on = run(true);
    expect(on.gapCalls).toContainEqual([GAP_VAR, '61px']);
    expect(readGapFixLog()).toMatch(/^gapfix css set=61 short=61$/m);
    expect(readGapFixLog()).toMatch(/^gapfix css set=0 short=414$/m);
    const offRun = run(false);
    expect(offRun.gapCalls.filter((c) => c[1] === '61px')).toEqual([]);
    expect(readGapFixLog()).toMatch(/^gapfix css off would=61 short=61$/m);
  });

  it('关着时键盘那边（data-kbo、data-kbhide 的先后）和开着一模一样', () => {
    expect(run(false).attrs).toEqual(run(true).attrs);
  });

  it('不传 cssGap 时读诊断页开关（开始监听时读一次）', () => {
    off('css');
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const vv = { height: 895, offsetTop: 0, scale: 1, addEventListener: () => undefined, removeEventListener: () => undefined };
    const w = createKeyboardWatcher({ vv: () => vv as never, innerHeight: () => 895, root: () => ({ style }), doc: () => null, standalone: () => true, editing: () => false, full: () => 956, phone: () => true });
    const stop = w.watch(() => undefined);
    expect(style.setProperty).not.toHaveBeenCalledWith(GAP_VAR, '61px');
    stop();
    setGapFixOn(true, undefined, 'css');
    const stop2 = w.watch(() => undefined);
    expect(style.setProperty).toHaveBeenCalledWith(GAP_VAR, '61px');
    stop2();
  });
});
