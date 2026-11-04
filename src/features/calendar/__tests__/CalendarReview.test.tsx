// 月历页面·FA-3 第二轮复审补的部分（11-04）之二：电脑周表头补班 / 放假（代码复审 N4）、现在线不压字（设计复审 N2）、
// 完成的待办不撑宽时间轴（代码复审 N5）、跨午夜日程的次日续段（N6）、h1（N7）、“今天”跨午夜跟着变、闰月的农历写法
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）09:00；界面语言中文（周一起始）
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
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

const ev = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `日程${id}`, short: null, project: '', date: '2026-11-10', time: '09:00', tz: TZ, duration_min: 60, created_at: 1, deleted_at: null, undone: false, ...over,
});
const todo = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `待办${id}`, short: null, project: '', due: '2026-11-04', due_time: null, done: false, created_at: 1, deleted_at: null, undone: false, ...over,
});

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const cell = (date: string) => document.querySelector<HTMLButtonElement>(`[data-testid="cal-month"] [data-date="${date}"]`);

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

describe('其他复审项', () => {
  it('页面有 h1（视觉隐藏，代码复审 N7）', () => {
    open('#/calendar');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('日历');
    expect(h1.className).toContain(styles.srOnly);
  });

  it('电脑周视图表头：补班写“班·名字”，放假的表头和那一列灰底（代码复审 N4）', async () => {
    stubWide();
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/cn/2026.json'
        ? { kind: 'ok', json: { country: 'cn', year: 2026, days: [{ date: '2026-11-03', kind: 'off', name: { zh: '测试假' } }, { date: '2026-11-07', kind: 'work', name: { zh: '测试假' } }] } }
        : { kind: 'missing' },
    );
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week').getAttribute('data-layout')).toBe('desk');
    const head = (d: string) => document.querySelector<HTMLElement>(`[data-testid="cal-week"] button[data-date="${d}"]`);
    await waitFor(() => expect(head('2026-11-07')?.textContent).toContain('班·测试假'));
    expect(head('2026-11-03')?.className).toContain(styles.dOff);
    expect(head('2026-11-07')?.className).not.toContain(styles.dOff);
    const cols = document.querySelectorAll(`[data-testid="cal-week"] .${styles.dCol}`);
    expect(cols[1]?.className).toContain(styles.dOff);
    expect(cols[5]?.className).not.toContain(styles.dOff);
  });

  it('补班写“班·名字”：“班”在最前，放不下时也看得见；名字带“补班”尾巴的去掉再拼（截图 11-04 发现）', async () => {
    const { holText } = await import('../ui/cal-ui.ts');
    expect(holText({ kind: 'work', name: '国庆节补班' }, '班')).toBe('班·国庆节');
    expect(holText({ kind: 'work', name: '测试假' }, '班')).toBe('班·测试假');
    expect(holText({ kind: 'work', name: '补班' }, '班')).toBe('班');
    // 韩文界面（B2K-06、R-338、R-340）：取到韩文名“춘절 대체 근무일”去“ 대체 근무일”再 trim；韩文名缺了回落中文名“元旦补班”时去“补班”
    expect(holText({ kind: 'work', name: '춘절 대체 근무일' }, '근무')).toBe('근무·춘절');
    expect(holText({ kind: 'work', name: '신정 대체 근무일' }, '근무')).toBe('근무·신정');
    expect(holText({ kind: 'work', name: '대체 근무일' }, '근무')).toBe('근무');
    expect(holText({ kind: 'work', name: '元旦补班' }, '근무')).toBe('근무·元旦');
    expect(holText({ kind: 'off', name: '国庆节' }, '班')).toBe('国庆节');
    // 读屏（B2K-08）：名字已带补班尾巴就不再加括号；没带的才加
    const { workdayA11y } = await import('../ui/cal-ui.ts');
    const koWrap = (name: string) => `${name}(대체 근무)`;
    const zhWrap = (name: string) => `${name}（补班）`;
    expect(workdayA11y('춘절 대체 근무일', koWrap)).toBe('춘절 대체 근무일');
    expect(workdayA11y('元旦补班', zhWrap)).toBe('元旦补班');
    expect(workdayA11y('测试假', zhWrap)).toBe('测试假（补班）');
  });

  it('韩国补休日窄处短写（负责人 11-04 定 L1）：手机月格写“대체휴일”、括号去掉，读屏照旧全称；电脑周表头照旧全称', async () => {
    data.settings = [{ id: 's1', key: 'cal.holidays', value: 'kr' }];
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/kr/2026.json'
        ? { kind: 'ok', json: { country: 'kr', year: 2026, days: [{ date: '2026-10-05', kind: 'off', name: { ko: '대체공휴일(개천절)' } }] } }
        : { kind: 'missing' },
    );
    open('#/cal/month/2026-10');
    await waitFor(() => expect(cell('2026-10-05')?.textContent).toContain('대체휴일'));
    expect(cell('2026-10-05')?.textContent).not.toContain('(개천절)');
    expect(cell('2026-10-05')?.getAttribute('aria-label')).toContain('대체공휴일(개천절)');
    cleanup();
    open('#/cal/week/2026-10-05');
    const lane = document.querySelector<HTMLElement>('[data-testid="cal-week"] li[data-date="2026-10-05"]');
    await waitFor(() => expect(lane?.textContent).toContain('대체휴일'));
    expect(lane?.querySelector('button')?.getAttribute('aria-label')).toContain('대체공휴일(개천절)');
    cleanup();
    stubWide();
    open('#/cal/week/2026-10-05');
    const head = () => document.querySelector<HTMLElement>('[data-testid="cal-week"] button[data-date="2026-10-05"]');
    await waitFor(() => expect(head()?.textContent).toContain('대체공휴일(개천절)'));
  });

  it('narrowHolName：只有以“대체공휴일”开头的换短写，别的照旧', async () => {
    const { narrowHolName, holText } = await import('../ui/cal-ui.ts');
    const n = { full: '대체공휴일', short: '대체휴일' };
    expect(narrowHolName('대체공휴일(개천절)', n)).toBe('대체휴일');
    expect(narrowHolName('대체공휴일', n)).toBe('대체휴일');
    expect(narrowHolName('개천절', n)).toBe('개천절');
    expect(holText({ kind: 'off', name: '대체공휴일(추석)' }, '班', n)).toBe('대체휴일');
    expect(holText({ kind: 'off', name: '대체공휴일(추석)' }, '班')).toBe('대체공휴일(추석)');
  });

  it('layoutTop：沿 offsetParent 链一路加到 root；中途祖先带 transform 变成 offsetParent 也照样算对（设计第三轮复审 H1 的根因）', async () => {
    const { layoutTop } = await import('../hooks/useMonthFold.ts');
    const page = document.createElement('main');
    const pager = document.createElement('div');
    const grid = document.createElement('div');
    const fake = (el: HTMLElement, top: number, parent: Element | null) => {
      Object.defineProperty(el, 'offsetTop', { configurable: true, get: () => top });
      Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => parent });
    };
    // 正常：grid 的 offsetParent 就是 page
    fake(grid, 143, page);
    expect(layoutTop(grid, page)).toBe(143);
    // 横滑时 pager 带 translateX、成了 grid 的 offsetParent：grid 相对 pager 25，pager 相对 page 118
    fake(grid, 25, pager);
    fake(pager, 118, page);
    expect(layoutTop(grid, page)).toBe(143);
    // 链上碰不到 root：加到顶为止
    fake(pager, 118, null);
    expect(layoutTop(grid, page)).toBe(143);
  });

  it('电脑周视图：现在线排在日程块前面（画在块下面，不压字；设计复审 N2）', () => {
    stubWide();
    data.events = [ev('1', { date: '2026-11-05', time: '08:30', duration_min: 90 })];
    open('#/cal/week/2026-11-05');
    const now = screen.getByTestId('cal-now');
    expect(now.parentElement?.firstElementChild).toBe(now);
  });

  it('已完成、删掉的待办不撑宽时间轴；没完成的照常撑（代码复审 N5）', () => {
    data.todos = [todo('a', { due_time: '05:30', done: true }), todo('b', { due_time: '06:30', deleted_at: 3 })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('8-22');
    cleanup();
    data.todos = [todo('a', { due_time: '05:30' })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('5-22');
  });

  it('跨午夜的日程：开始那天照常列出，次日清单最前面补一行续段“至 01:00”，件数也算上（代码复审 N6）', () => {
    data.events = [ev('1', { title: '通宵', date: '2026-11-09', time: '23:00', duration_min: 120 }), ev('2', { title: '早会', date: '2026-11-10', time: '09:00' })];
    open('#/cal/month/2026-11');
    fireEvent.click(cell('2026-11-09') as HTMLElement);
    expect(within(screen.getByTestId('cal-day-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['23:00通宵']);
    fireEvent.click(cell('2026-11-10') as HTMLElement);
    const list = screen.getByTestId('cal-day-list');
    const rows = within(list).getAllByRole('button');
    expect(rows.map((b) => b.textContent)).toEqual(['至 01:00通宵', '09:00早会']);
    expect(rows[0]?.getAttribute('data-kind')).toBe('cont');
    expect(list.textContent).toContain('2 项');
    fireEvent.click(cell('2026-11-11') as HTMLElement);
    expect(screen.getByTestId('cal-day-list').textContent).toContain('这一天没有安排');
  });

  it('跨两天以上的：中间那天写“至 24:00”', () => {
    data.events = [ev('1', { title: '展会', date: '2026-11-09', time: '22:00', duration_min: 30 * 60 })];
    open('#/cal/month/2026-11');
    fireEvent.click(cell('2026-11-10') as HTMLElement);
    expect(within(screen.getByTestId('cal-day-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['至 24:00展会']);
    fireEvent.click(cell('2026-11-11') as HTMLElement);
    expect(within(screen.getByTestId('cal-day-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['至 04:00展会']);
  });

  it('“今天”跨过午夜跟着变：今天的圈、默认选中的那天都换到新的一天', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = vi.spyOn(clock, 'now').mockReturnValue(msAt('2026-11-05', 23 * 60 + 59, TZ) + 30_000);
    open('#/cal/month/2026-11');
    expect(cell('2026-11-05')?.className).toContain(styles.today);
    expect(screen.getByTestId('cal-day-list').getAttribute('data-date')).toBe('2026-11-05');
    now.mockReturnValue(msAt('2026-11-06', 0, TZ) + 60_000);
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(cell('2026-11-06')?.className).toContain(styles.today);
    expect(cell('2026-11-05')?.className).not.toContain(styles.today);
    expect(screen.getByTestId('cal-day-list').getAttribute('data-date')).toBe('2026-11-06');
  });

  it('“今天”跨过月底：11-30 → 12-01 时本月变成“不在本月”，“今天”按钮变黑', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = vi.spyOn(clock, 'now').mockReturnValue(msAt('2026-11-30', 23 * 60 + 59, TZ) + 30_000);
    open('#/cal/month/2026-11');
    expect(screen.getByTestId('cal-today').getAttribute('aria-disabled')).toBe('true');
    now.mockReturnValue(msAt('2026-12-01', 0, TZ) + 60_000);
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('cal-today').hasAttribute('aria-disabled')).toBe(false);
  });

  it('闰月：2025 年闰六月初一（7-25）格子写“闰六月”，读屏带完整写法', async () => {
    open('#/cal/month/2025-07');
    await waitFor(() => expect(cell('2025-07-25')?.textContent).toContain('闰六月'));
    expect(cell('2025-07-25')?.getAttribute('aria-label')).toContain('农历闰六月初一');
    // 前一天还是六月（非闰）
    expect(cell('2025-07-24')?.getAttribute('aria-label')).toMatch(/农历六月(廿九|三十)/);
  });
});

// 代码复审 R1：收起的补间进行到一半被系统取消（pointercancel）——画面回到页面记的状态（收起），
// 和拖动柄的 aria-expanded、别的行 inert 一致；不按按下时的进度吸附回展开
describe('补间中被取消：画面和状态一致', () => {
  it('点柄收起、补间才走一点就按住又被取消：别的行最后透明度 0，aria-expanded 仍是 false、仍 inert', () => {
    let now = 0;
    const q: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => q.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => q.splice(0));
    const flush = (at: number) => act(() => {
      now = at;
      for (let n = 0; q.length > 0 && n < 50; n++) q.shift()?.(now);
    });
    open('#/cal/month/2026-11');
    const btn = screen.getByTestId('cal-fold');
    fireEvent.click(btn);
    act(() => {
      now = 10;
      q.shift()?.(now);
    });
    const mid = Number(cell('2026-11-12')?.style.opacity);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
    fireEvent.pointerDown(btn, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerCancel(btn, { pointerId: 1 });
    flush(10_000);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(cell('2026-11-12')?.hasAttribute('inert')).toBe(true);
    expect(cell('2026-11-12')?.style.opacity).toBe('0');
  });
});

