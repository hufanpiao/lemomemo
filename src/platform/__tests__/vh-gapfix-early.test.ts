// 台账 Q-2 早试（platform/vh-gapfix-gate.ts 的 startEarlyGapFix，11-11）：负责人真机日志 Gap fix 等底栏挂上 t=1571 才放垫块、t=1586 就变 956，
// 启动画面盖着的这段底下一直是灰带。main.tsx 一开始同步早试一次（同样的垫块），不成再由 vh-gapfix.ts 等底栏挂上后照原样做；早试的时刻和结果记进 Gap fix 日志
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAP_MAX_PX } from '../viewport-geom.ts';
import { readGapFixLog, startGapFix } from '../vh-gapfix.ts';
import { EARLY_GIVE_UP_MS, earlyGap, startEarlyGapFix, type EarlyGap } from '../vh-gapfix-gate.ts';
import { deps, frames, mountBar, pad, setInner } from './gapfix-fixture.ts';

describe('台账 Q-2 早试（main.tsx 一开始同步试一次，vh-gapfix-gate.ts）', () => {
  it('早试还没结束：不判断、不放第二块垫块；结束后先记 early 一行，再照原样做', () => {
    const fr = frames();
    const e: EarlyGap = { at: 120, done: false, what: '' };
    mountBar();
    startGapFix(fr.frame, { ...deps(), early: () => e });
    fr.flush(5);
    expect(pad()).toBeNull();
    expect(readGapFixLog()).not.toMatch(/early|pad gap/);
    e.done = true;
    e.what = 'no-change after=1000ms gap=61 top=61';
    fr.flush(1);
    const log = readGapFixLog();
    expect(log).toMatch(/early nav=120ms no-change after=1000ms gap=61 top=61/);
    expect(log.indexOf('early nav=')).toBeLessThan(log.indexOf('pad gap=61'));
    expect(pad()).not.toBeNull();
  });

  it('早试成了（inner 已是 956）：记 early changed，后面只 skip no-gap，不放垫块', () => {
    const fr = frames();
    setInner(956);
    mountBar();
    startGapFix(fr.frame, { ...deps(), early: () => ({ at: 80, done: true, what: 'changed 895->956 after=16ms gap=61 top=61' }) });
    const log = readGapFixLog();
    expect(log).toMatch(/early nav=80ms changed 895->956 after=16ms/);
    expect(log).toMatch(/skip no-gap\(0\)/);
    expect(pad()).toBeNull();
  });

  it('日志第一行带页面打开起算的时刻 nav=', () => {
    const fr = frames();
    mountBar();
    startGapFix(fr.frame, { ...deps(), early: () => null });
    expect(readGapFixLog()).toMatch(/^gapfix start=\S+ nav=\d+ms screen=440x956/);
  });
});

describe('startEarlyGapFix（早试本身）', () => {
  const win = () => window;
  let t = 0;
  const now = () => t;
  /** 顶部安全区（jsdom 算不出 var(--inset-top)，直接给值） */
  let topPx = 0;
  const setTop = (px: number) => {
    topPx = px;
  };
  const readTop = () => topPx;
  afterEach(() => {
    topPx = 0;
    t = 0;
  });

  it('895 / 956：同步放垫块（不等帧、不等底栏），回到整屏就撤、记 changed 和用时', () => {
    setTop(61);
    t = 300;
    const fr = frames();
    const e = startEarlyGapFix(fr.frame, win(), now, readTop);
    expect(e.at).toBe(300);
    expect(e.done).toBe(false);
    const el = pad();
    expect(el).not.toBeNull();
    expect(el?.style.position).toBe('absolute');
    expect(el?.style.visibility).toBe('hidden');
    expect(el?.style.pointerEvents).toBe('none');
    expect(el?.style.height).toBe('calc(100dvh + 62px)');
    expect(earlyGap()).toBe(e);
    t = 316;
    setInner(956);
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(e.done).toBe(true);
    expect(e.what).toBe('changed 895->956 after=16ms gap=61 top=61');
  });

  it('Q-2 复发（11-11 真机日志 changed 894->895）：innerHeight 只抖了 1px 不算成，垫块留着；变到整屏才撤', () => {
    setInner(894);
    const fr = frames();
    const e = startEarlyGapFix(fr.frame, win(), now, readTop);
    expect(pad()).not.toBeNull();
    t = 10;
    setInner(895);
    fr.flush(1);
    expect(pad()).not.toBeNull();
    expect(e.done).toBe(false);
    t = 40;
    setInner(956);
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(e.what).toBe('changed 894->956 after=40ms gap=62 top=0');
  });

  it(`顶部安全区还读到 0 也试（差值不超过 ${GAP_MAX_PX}）；到 ${EARLY_GIVE_UP_MS}ms 没变就撤、记 no-change`, () => {
    const fr = frames();
    const e = startEarlyGapFix(fr.frame, win(), now, readTop);
    expect(pad()).not.toBeNull();
    t = EARLY_GIVE_UP_MS - 1;
    fr.flush(1);
    expect(pad()).not.toBeNull();
    t = EARLY_GIVE_UP_MS;
    fr.flush(1);
    expect(pad()).toBeNull();
    expect(e.what).toBe(`no-change inner=895 after=${EARLY_GIVE_UP_MS}ms gap=61 top=0`);
    expect(fr.size).toBe(0);
  });

  it('正常启动、横屏、差值不是顶部安全区、差值太大：不放垫块，直接记 skip 和原因（同 skipReason）', () => {
    const cases: Array<[number, number, number, string]> = [
      [956, 440, 61, 'skip no-gap(0) gap=0 top=61'],
      // 横屏整屏取 screen 短边 440
      [400, 900, 0, 'skip landscape gap=40 top=0'],
      [895, 440, 24, 'skip gap-not-top(gap=61 top=24) gap=61 top=24'],
      [700, 440, 0, 'skip gap-not-top(gap=256 top=0) gap=256 top=0'],
    ];
    for (const [h, w, top, what] of cases) {
      setInner(h);
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(w);
      setTop(top);
      const fr = frames();
      const e = startEarlyGapFix(fr.frame, win(), now, readTop);
      expect(pad()).toBeNull();
      expect(e.done).toBe(true);
      expect(e.what).toBe(what);
      expect(fr.size).toBe(0);
    }
  });
});
