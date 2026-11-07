// 启动时盯住底部安全区（platform/inset-watch.ts，G10）：稳定前 <html data-inset-wait>，稳定了去掉；时间线记下每次变化
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSET_BACKSTOP_MS, INSET_LATE_LOG_MS, INSET_LATE_POLL_MS, INSET_MAX_MS, INSET_POLL_MS, INSET_QUIET_MS, INSET_WAIT_ATTR, INSET_ZERO_WAIT_MS, insetTimeline, markInsetPainted,
  watchInsetBottom,
} from '../inset-watch.ts';
import { insetTimelineLine } from '../diag-info.ts';

let stopIt: (() => void) | null = null;
afterEach(() => {
  stopIt?.();
  stopIt = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 假的安全区：getComputedStyle 读探针时返回 sab；standalone 可选；painted 默认马上算首屏画完 */
function setup(opts: { sab: string; standalone?: boolean; painted?: boolean }) {
  vi.useFakeTimers();
  const state = { sab: opts.sab };
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
    const cs = real(el, p);
    if (el instanceof HTMLElement && el.style.getPropertyValue('padding-bottom').includes('--inset-bottom')) {
      return { ...cs, paddingBottom: state.sab } as CSSStyleDeclaration;
    }
    return cs;
  });
  // jsdom 没有 matchMedia
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') && opts.standalone === true }) as MediaQueryList);
  const now = () => Date.now();
  stopIt = watchInsetBottom({ win: window, now });
  if (opts.painted !== false) markInsetPainted();
  const t0 = Date.now();
  return { state, t0 };
}

const waiting = (): boolean => document.documentElement.hasAttribute(INSET_WAIT_ATTR);

describe('watchInsetBottom', () => {
  it('挂上时 <html> 带 data-inset-wait；不是主屏幕版、值一直不变：INSET_QUIET_MS 后去掉', () => {
    setup({ sab: '0px' });
    expect(waiting()).toBe(true);
    vi.advanceTimersByTime(INSET_QUIET_MS + INSET_POLL_MS);
    expect(waiting()).toBe(false);
    expect(insetTimeline().reason).toBe('quiet');
  });

  it('主屏幕版先 0 后 34：读到 0 时等着，变成 34 以后再稳定 INSET_QUIET_MS 才放行；时间线有两条', () => {
    const { state } = setup({ sab: '0px', standalone: true });
    vi.advanceTimersByTime(300);
    expect(waiting()).toBe(true); // 0 可能还没给真值
    state.sab = '34px';
    vi.advanceTimersByTime(INSET_POLL_MS);
    expect(waiting()).toBe(true); // 刚变，还不稳定
    vi.advanceTimersByTime(INSET_QUIET_MS + INSET_POLL_MS);
    expect(waiting()).toBe(false);
    const tl = insetTimeline();
    expect(tl.rows.map((r) => r.env)).toEqual(['0px', '34px']);
    expect(tl.standalone).toBe(true);
    expect(insetTimelineLine(tl)).toMatch(/^launch: standalone=true painted=\+\d+ ready=\+\d+\(quiet\) \| \+\d+ env-bottom=0px inner=\d+ \| \+\d+ env-bottom=34px inner=\d+$/);
  });

  it('主屏幕版一直是 0（没有 Home 横条）：等到 INSET_ZERO_WAIT_MS 放行，不硬兜成 34', () => {
    setup({ sab: '0px', standalone: true });
    vi.advanceTimersByTime(INSET_ZERO_WAIT_MS - INSET_POLL_MS * 2);
    expect(waiting()).toBe(true);
    vi.advanceTimersByTime(INSET_POLL_MS * 3);
    expect(waiting()).toBe(false);
    expect(insetTimeline().rows.map((r) => r.env)).toEqual(['0px']);
  });

  it('首屏没画完时不放行（底栏还没出来，计时不算）；画完以后才开始算稳定', () => {
    setup({ sab: '0px', painted: false });
    vi.advanceTimersByTime(2000);
    expect(waiting()).toBe(true);
    markInsetPainted();
    vi.advanceTimersByTime(INSET_QUIET_MS - INSET_POLL_MS);
    expect(waiting()).toBe(true);
    vi.advanceTimersByTime(INSET_POLL_MS * 2);
    expect(waiting()).toBe(false);
    expect(insetTimeline().paintedAt).toBe(2000 + (insetTimeline().rows[0]?.t ?? NaN));
  });

  it('一直没画完（没登录跳走、整屏提示）：INSET_BACKSTOP_MS 兜底放行', () => {
    setup({ sab: '0px', painted: false });
    vi.advanceTimersByTime(INSET_BACKSTOP_MS - 10);
    expect(waiting()).toBe(true);
    vi.advanceTimersByTime(20);
    expect(waiting()).toBe(false);
    expect(insetTimeline().reason).toBe('max');
    // 兜底放行以后不再轮询：没有挂着的定时器，再过很久也不会再排（代码审查 11-06）
    expect(vi.getTimerCount()).toBe(0);
    const spy = vi.spyOn(window, 'setTimeout');
    vi.advanceTimersByTime(INSET_BACKSTOP_MS * 2);
    expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('放行以后：底栏照样马上显示、不再按 INSET_POLL_MS 轮询；时间线低频再记到画完后 INSET_LATE_LOG_MS，之后没有定时器（主持人 11-07）', () => {
    const { state, t0 } = setup({ sab: '0px' });
    vi.advanceTimersByTime(INSET_QUIET_MS + INSET_POLL_MS * 2);
    expect(waiting()).toBe(false);
    const readyAt = insetTimeline().readyAt;
    // 放行以后只剩一个低频定时器，间隔是 INSET_LATE_POLL_MS（不是 40ms）
    expect(vi.getTimerCount()).toBe(1);
    const spy = vi.spyOn(window, 'setTimeout');
    vi.advanceTimersByTime(INSET_LATE_POLL_MS);
    expect(spy.mock.calls.every(([, ms]) => (ms ?? 0) >= INSET_LATE_POLL_MS || Date.now() + (ms ?? 0) >= t0 + INSET_LATE_LOG_MS)).toBe(true);
    // 放行以后 iOS 才给出 34：时间线记下这一条，底栏不再藏、放行时刻不变
    state.sab = '34px';
    vi.advanceTimersByTime(INSET_LATE_POLL_MS);
    expect(insetTimeline().rows.map((r) => r.env)).toEqual(['0px', '34px']);
    expect(insetTimeline().rows.at(-1)?.t ?? 0).toBeGreaterThan(readyAt ?? Infinity);
    expect(waiting()).toBe(false);
    expect(insetTimeline().readyAt).toBe(readyAt);
    expect(insetTimelineLine()).toContain('env-bottom=34px');
    // 画完后 INSET_LATE_LOG_MS 停：没有挂着的定时器，再过很久也不再排，后面的变化（没有 resize）不记
    vi.advanceTimersByTime(t0 + INSET_LATE_LOG_MS - Date.now());
    expect(vi.getTimerCount()).toBe(0);
    spy.mockClear();
    state.sab = '20px';
    vi.advanceTimersByTime(INSET_BACKSTOP_MS * 2);
    expect(spy).not.toHaveBeenCalled();
    expect(insetTimeline().rows).toHaveLength(2);
  });

  it('放行以后低频记录总时长不超过挂上后 INSET_BACKSTOP_MS（画完得很晚时）', () => {
    const { t0 } = setup({ sab: '34px', painted: false });
    vi.advanceTimersByTime(INSET_BACKSTOP_MS - 500);
    expect(waiting()).toBe(true);
    markInsetPainted(); // 画完后 INSET_MAX_MS 内稳定放行
    vi.advanceTimersByTime(INSET_QUIET_MS + INSET_POLL_MS * 2);
    expect(waiting()).toBe(false);
    vi.advanceTimersByTime(t0 + INSET_BACKSTOP_MS - Date.now());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('一直在变：画完后最多藏 INSET_MAX_MS（reason=max）', () => {
    const { state } = setup({ sab: '0px', standalone: true });
    let n = 0;
    const flip = setInterval(() => {
      n += 1;
      state.sab = `${n}px`;
    }, INSET_POLL_MS);
    vi.advanceTimersByTime(INSET_MAX_MS - 10);
    expect(waiting()).toBe(true);
    vi.advanceTimersByTime(20);
    clearInterval(flip);
    expect(waiting()).toBe(false);
    expect(insetTimeline().reason).toBe('max');
  });

  it('innerHeight 变了也算变化、记一条；取消后探针拿掉、属性去掉', () => {
    setup({ sab: '34px' });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    window.dispatchEvent(new Event('resize'));
    expect(insetTimeline().rows.at(-1)?.inner).toBe(900);
    stopIt?.();
    stopIt = null;
    expect(waiting()).toBe(false);
    expect([...document.body.children].some((e) => (e as HTMLElement).style.getPropertyValue('padding-bottom').includes('--inset-bottom'))).toBe(false);
  });
});
