// 月历页面·FA-3 第二轮复审补的部分（11-04）之一：上拖收起（R-326）、同一页内翻页不起 View Transition（代码复审 N1）、按钮横滑、
// 手机选择器遮罩（设计复审 N1）、年列单个 Tab 停靠点（代码复审 N3）、周视图提示缩短（设计复审 N5）。其余复审项见 CalendarReview.test.tsx
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）09:00；界面语言中文（周一起始）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

type Row = { id: string } & Record<string, unknown>;
const data: { events: Row[]; todos: Row[]; settings: Row[] } = { events: [], todos: [], settings: [] };
const collections: Record<string, () => Row[]> = { events: () => data.events, todos: () => data.todos, settings: () => data.settings };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => collections[name]?.() ?? [],
}));
const fetchStatus = vi.fn(async (_p: string): Promise<AppJson> => ({ kind: 'missing' }));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: (p: string) => fetchStatus(p) }));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const { styles } = await import('./css-of.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);
const W = 336;


function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const cell = (date: string) => document.querySelector<HTMLButtonElement>(`[data-testid="cal-month"] [data-date="${date}"]`);
const key = (k: string) => fireEvent.keyDown(document.body, { key: k });
const fold = () => screen.getByTestId('cal-fold');

/** 电脑宽度（≥ 768 px）：只让宽度查询成立，“减少动态效果”的查询照旧不成立 */
function stubWide(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 768px'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
}

class FakeRO {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: W, height: 44, x: 0, y: 0, top: 0, left: 0, right: W, bottom: 44, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal('ResizeObserver', FakeRO);
  data.events = [];
  data.todos = [];
  data.settings = [];
  fetchStatus.mockReset();
  fetchStatus.mockResolvedValue({ kind: 'missing' });
  resetHolidayCacheForTest();
  resetLunarForTest(async () => realLunar);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete document.documentElement.dataset.rm;
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

describe('上拖收起（线框 s3、R-326）', () => {
  it('拖动柄是按钮：aria-expanded、aria-controls 指向月格；点一下收起，只留今天那一周，别的行 inert；再点展开', async () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/2026-11');
    const btn = fold();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('收起成一周');
    expect(document.getElementById(btn.getAttribute('aria-controls') ?? '')).toBe(document.querySelector(`[data-testid="cal-month"] .${styles.grid}`));
    expect(screen.getByTestId('cal-prev').getAttribute('aria-label')).toBe('上个月');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('展开整月');
    expect(screen.getByTestId('calendar-page').getAttribute('data-folded')).toBe('true');
    // 今天 11-05 在 11-02～11-08 那一行
    for (const d of ['2026-11-02', '2026-11-05', '2026-11-08']) expect(cell(d)?.hasAttribute('inert')).toBe(false);
    for (const d of ['2026-10-26', '2026-11-01', '2026-11-12', '2026-12-06']) expect(cell(d)?.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('cal-legend').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('cal-prev').getAttribute('aria-label')).toBe('上一周');
    expect(screen.getByTestId('cal-next').getAttribute('aria-label')).toBe('下一周');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(cell('2026-11-12')?.hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('cal-legend').hasAttribute('aria-hidden')).toBe(false);
  });

  it('锚点是选中那天的一行：先点 11-19 再收起，留下 11-16～11-22', () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/2026-11');
    fireEvent.click(cell('2026-11-19') as HTMLElement);
    fireEvent.click(fold());
    expect(cell('2026-11-16')?.hasAttribute('inert')).toBe(false);
    expect(cell('2026-11-05')?.hasAttribute('inert')).toBe(true);
  });

  it('收起后 ‹ › 按周翻（选中的那天挪 7 天，地址不变）；跨月时换月；“今天”灰不灰按今天在不在这一行', async () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/2026-11');
    fireEvent.click(fold());
    expect(screen.getByTestId('cal-today').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('cal-next'));
    expect(cell('2026-11-12')?.getAttribute('aria-pressed')).toBe('true');
    expect(cell('2026-11-12')?.hasAttribute('inert')).toBe(false);
    expect(cell('2026-11-05')?.hasAttribute('inert')).toBe(true);
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    expect(screen.getByTestId('cal-today').hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('cal-next'));
    fireEvent.click(screen.getByTestId('cal-next'));
    expect(cell('2026-11-26')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-12');
    expect(cell('2026-12-03')?.getAttribute('aria-pressed')).toBe('true');
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-today'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    expect(cell('2026-11-05')?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('cal-today').getAttribute('aria-disabled')).toBe('true');
  });

  it('收起后键盘 ← → 也按周翻；T 回今天', async () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/2026-11');
    fireEvent.click(fold());
    await act(async () => {
      key('ArrowLeft');
    });
    expect(window.location.hash).toBe('#/cal/month/2026-10');
    expect(cell('2026-10-29')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      key('t');
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
  });

  it('到 1900 年第一周：收起后“上一周”aria-disabled', async () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/1900-01');
    fireEvent.click(fold());
    expect(screen.getByTestId('cal-prev').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('cal-next').hasAttribute('aria-disabled')).toBe(false);
  });

  it('周视图没有拖动柄', () => {
    open('#/cal/week/2026-11-05');
    expect(screen.queryByTestId('cal-fold')).toBeNull();
  });
});

describe('翻页动画（架构 5.12，代码复审 N1）', () => {
  it('同一页内翻页不起 View Transition：‹ ›、← →、“今天”、年月选择、切周 / 月、收起后跨月都不调 startViewTransition；换页面才调', async () => {
    const vt = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = vt;
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-12');
    await act(async () => {
      key('ArrowRight');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-today'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('cal-picker')).getByText('3月'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-03');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-mode-week'));
    });
    expect(window.location.hash).toMatch(/^#\/cal\/week\//);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-mode-month'));
    });
    fireEvent.click(fold());
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('cal-next'));
      });
    }
    expect(vt).not.toHaveBeenCalled();
    // 对照：换到别的页面照常起 View Transition（证明替身生效）
    await act(async () => {
      await navigate('settings');
    });
    expect(vt).toHaveBeenCalledTimes(1);
  });

  it('‹ › 按钮：新的一页从那一侧横滑进来（先放在一侧，再带过渡回 0）；键盘直接切换、不横滑', async () => {
    open('#/cal/month/2026-11');
    const pager = screen.getByTestId('cal-pager');
    fireEvent.click(screen.getByTestId('cal-next'));
    expect(window.location.hash).toBe('#/cal/month/2026-12');
    expect(pager.style.transform).toBe(`translateX(${W}px)`);
    await waitFor(() => expect(pager.style.transform).toBe(''));
    expect(pager.className).toContain(styles.settling);
    fireEvent.click(screen.getByTestId('cal-prev'));
    expect(pager.style.transform).toBe(`translateX(${-W}px)`);
    await waitFor(() => expect(pager.style.transform).toBe(''));
    await act(async () => {
      key('ArrowRight');
    });
    expect(pager.style.transform).toBe('');
  });

  it('减少动态效果：按钮翻页也不横滑', async () => {
    document.documentElement.dataset.rm = '1';
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-12');
    expect(screen.getByTestId('cal-pager').style.transform).toBe('');
  });
});

describe('年月选择器（设计复审 N1、N5，代码复审 N3）', () => {
  it('手机：打开时后面有半透明遮罩，收起就没了；年列只有正在看的那一年能 Tab 到', async () => {
    open('#/cal/month/2026-11');
    expect(screen.queryByTestId('cal-picker-scrim')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    expect(screen.getByTestId('cal-picker-scrim')).toBeTruthy();
    const years = within(screen.getByTestId('cal-picker')).getAllByRole('button').filter((b) => b.hasAttribute('data-year'));
    expect(years).toHaveLength(201);
    const tabbable = years.filter((b) => b.getAttribute('tabindex') === '0');
    expect(tabbable.map((b) => b.getAttribute('data-year'))).toEqual(['2026']);
    fireEvent.click(years.find((b) => b.getAttribute('data-year') === '2030') as HTMLElement);
    expect(years.filter((b) => b.getAttribute('tabindex') === '0').map((b) => b.getAttribute('data-year'))).toEqual(['2030']);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('cal-picker'), { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('cal-picker-scrim')).toBeNull());
  });

  it('电脑：不压暗', async () => {
    stubWide();
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    expect(screen.getByTestId('cal-picker')).toBeTruthy();
    expect(screen.queryByTestId('cal-picker-scrim')).toBeNull();
  });

  it('周视图的底部提示缩短了（不折行）', async () => {
    open('#/cal/week/2026-11-05');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    expect(screen.getByTestId('cal-picker').textContent).toContain('跳到该月 1 日那周 · 小点是今天');
  });
});
