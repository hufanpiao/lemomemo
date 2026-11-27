// 冷启动高度校正（platform/vh-gapfix-gate.ts 的 startGapFix，“布局视口少一截”唯一的一套）：main.tsx 一开始同步做这一次（台账 Q-2：
// 负责人真机日志等底栏挂上 t=1571 才放垫块，启动画面盖着的这段底下一直是灰带）。主屏幕版 iPhone 竖屏冷启动：innerHeight 895、screen 440×956；帧手动推进。
// 11-24 负责人真机 16 次冷启动（去重后）都是这一次就修好（changed 894->956，13～41ms，gap-after=0），所以等底栏后、收键盘后两次触发和 CSS 补偿 --vh-gap 已删（代码结构审查 11-25 第 8 条）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAP_MAX_PX } from '../viewport-screen.ts';
import { GIVE_UP_MS, PAD_ID, startGapFix } from '../vh-gapfix-gate.ts';

/** 手动推进的“帧” */
function frames() {
  const q: Array<() => void> = [];
  return {
    frame: (cb: () => void) => q.push(cb),
    flush(n = 1) {
      for (let k = 0; k < n; k++) q.shift()?.();
    },
    get size() {
      return q.length;
    },
  };
}

let inner = 895;
let t = 0;
/** 顶部安全区（jsdom 算不出 var(--inset-top)，直接给值） */
let topPx = 0;
let lines: string[] = [];
const setInner = (h: number): void => {
  inner = h;
};
const pad = (): HTMLElement | null => document.getElementById(PAD_ID);
const run = (fr: ReturnType<typeof frames>): void => startGapFix(fr.frame, { now: () => t, readTop: () => topPx, log: (l) => lines.push(l) });
/** 结果那一行（gapfix early …） */
const result = (): string => lines.filter((l) => l.startsWith('gapfix early ')).join('\n');

beforeEach(() => {
  inner = 895;
  t = 0;
  topPx = 0;
  lines = [];
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(440);
  vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
  vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('startGapFix（冷启动高度校正，唯一的一次）', () => {
  it('895 / 956：同步放垫块（不等帧、不等底栏），回到整屏就撤；日志先记量到的输入，再记结果、用时和 gap-after', () => {
    topPx = 61;
    t = 300;
    const fr = frames();
    run(fr);
    expect(lines[0]).toBe('gapfix start nav=300ms screen=440x956 inner=895 full=956');
    const el = pad();
    expect(el).not.toBeNull();
    expect(el?.style.position).toBe('absolute');
    expect(el?.style.visibility).toBe('hidden');
    expect(el?.style.pointerEvents).toBe('none');
    expect(el?.style.height).toBe('calc(100dvh + 62px)');
    expect(result()).toBe('');
    t = 316;
    setInner(956);
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(result()).toBe('gapfix early nav=300ms changed 895->956 after=16ms gap=61 top=61 gap-after=0');
    expect(fr.size).toBe(0);
  });

  it('Q-2 复发（11-11 真机日志 changed 894->895）：innerHeight 只抖了 1px 不算成，垫块留着；变到整屏才撤', () => {
    setInner(894);
    const fr = frames();
    run(fr);
    expect(pad()).not.toBeNull();
    t = 10;
    setInner(895);
    fr.flush(1);
    expect(pad()).not.toBeNull();
    expect(result()).toBe('');
    t = 40;
    setInner(956);
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(result()).toBe('gapfix early nav=0ms changed 894->956 after=40ms gap=62 top=0 gap-after=0');
  });

  it(`顶部安全区还读到 0 也试（差值不超过 ${GAP_MAX_PX}）；到 ${GIVE_UP_MS}ms 没回到整屏就撤、记 no-change 和还少多少，之后不再试`, () => {
    const fr = frames();
    run(fr);
    expect(pad()).not.toBeNull();
    t = GIVE_UP_MS - 1;
    fr.flush(1);
    expect(pad()).not.toBeNull();
    t = GIVE_UP_MS;
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(result()).toBe(`gapfix early nav=0ms no-change inner=895 after=${GIVE_UP_MS}ms gap=61 top=0 gap-after=61`);
    expect(fr.size).toBe(0);
  });

  it('正常启动、横屏、差值不是顶部安全区、差值太大：不放垫块，直接记 skip 和原因', () => {
    const cases: Array<[number, number, number, string]> = [
      [956, 440, 61, 'skip no-gap(0) gap=0 top=61'],
      // 横屏整屏取 screen 短边 440
      [400, 900, 0, 'skip landscape gap=40 top=0'],
      [895, 440, 24, 'skip gap-not-top(gap=61 top=24) gap=61 top=24'],
      [700, 440, 0, 'skip gap-not-top(gap=256 top=0) gap=256 top=0'],
    ];
    for (const [h, w, top, what] of cases) {
      lines = [];
      setInner(h);
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(w);
      topPx = top;
      const fr = frames();
      run(fr);
      expect(pad()).toBeNull();
      expect(result()).toBe(`gapfix early nav=0ms ${what}`);
      expect(fr.size).toBe(0);
    }
  });

  it('默认经 rlog 记进全局运行日志（不记用户输入，只有数）', async () => {
    const { RL_SLOT } = await import('../run-log-api.ts');
    const got: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const old = g[RL_SLOT];
    g[RL_SLOT] = { q: [], sink: (l: string) => got.push(l) };
    try {
      setInner(956);
      startGapFix(frames().frame, { now: () => 5, readTop: () => 61 });
      expect(got).toEqual(['gapfix start nav=5ms screen=440x956 inner=956 full=956', 'gapfix early nav=5ms skip no-gap(0) gap=0 top=61']);
    } finally {
      g[RL_SLOT] = old;
    }
  });
});
