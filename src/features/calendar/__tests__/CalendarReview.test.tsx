// 月历页面·FA-3 第二轮复审补的部分（11-04）之二：电脑周表头补班 / 放假（代码复审 N4）、现在线不压字（设计复审 N2）、
// 完成的待办不撑宽时间轴（代码复审 N5）、跨午夜日程的次日续段（N6）、h1（N7）、“今天”跨午夜跟着变、闰月的农历写法
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）09:00；界面语言中文（周一起始）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const { lazyLib } = await import('../../../core/anniv-lib.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const { styles } = await import('./css-of.ts');
const { default: refine } = await import('../../../kit/components/Refine.module.css');

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
  // 这组按周一起始写的排版（负责人 11-18 首装默认改成周日，这里明确设周一，测的不是默认值）
  data.settings = [{ id: 'ws1', key: 'cal.week_start', value: 1, deleted_at: null, undone: false }];
  fetchStatus.mockReset();
  fetchStatus.mockResolvedValue({ kind: 'missing' });
  resetHolidayCacheForTest();
  resetLunarForTest(lazyLib('lunar', async () => realLunar));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete document.documentElement.dataset.rm;
});

/** 选中那天清单的行（ul 里的按钮；面板最上面的今日运势卡也是按钮，不算） */
const dayRows = (): HTMLElement[] => [...screen.getByTestId('cal-day-list').querySelectorAll<HTMLElement>('li > button')];
describe('其他复审项', () => {
  it('页面有 h1（视觉隐藏，代码复审 N7）', () => {
    open('#/calendar');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('日历');
    // 读屏隐藏类在 kit Refine.module.css（独立评审 11-18 三-14）
    expect(h1.className).toContain(refine.srOnly);
  });

  it('电脑周视图表头：补班日数字旁“班”标、下面写名字（11-17 日历整块评审第 6 条起和月格、泳道同一份 dayLines）；放假、补班的表头和那一列画斜纹（和月格同一个类）；连休只在第一天写名字（代码复审 N4、R-432）', async () => {
    stubWide();
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/cn/2026.json'
        ? {
            kind: 'ok',
            json: {
              country: 'cn',
              year: 2026,
              days: [
                { date: '2026-11-03', kind: 'off', name: { zh: '测试假' } },
                { date: '2026-11-04', kind: 'off', name: { zh: '测试假' } },
                { date: '2026-11-07', kind: 'work', name: { zh: '测试假' } },
              ],
            },
          }
        : { kind: 'missing' },
    );
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week').getAttribute('data-layout')).toBe('desk');
    const head = (d: string) => document.querySelector<HTMLElement>(`[data-testid="cal-week"] button[data-date="${d}"]`);
    await waitFor(() => expect(head('2026-11-07')?.querySelector('small')?.textContent).toBe('测试假'));
    expect(['2026-11-07', '2026-11-05'].map((d) => head(d)?.querySelector('[data-testid="cal-ban"]')?.textContent ?? null)).toEqual(['班', null]);
    expect(head('2026-11-03')?.textContent).toContain('测试假');
    expect(head('2026-11-04')?.textContent).not.toContain('测试假');
    for (const d of ['2026-11-03', '2026-11-04']) expect(head(d)?.className).toContain(styles.holiday);
    expect(head('2026-11-07')?.className).not.toContain(styles.holiday);
    expect(head('2026-11-07')?.className).toContain(styles.workday);
    expect(head('2026-11-05')?.className).not.toContain(styles.workday);
    const cols = document.querySelectorAll(`[data-testid="cal-week"] .${styles.dCol}`);
    expect(cols[1]?.className).toContain(styles.holiday);
    expect(cols[5]?.className).toContain(styles.workday);
    expect(cols[3]?.className).not.toContain(styles.holiday);
    expect(Object.keys(styles)).not.toContain('dOff');
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

  it('foldFrame（R-457 C 压扁收起）：锚点那一行被上面的行带上去；别的行压扁淡掉；月格裁掉、日清单上移的都是“六行高 − 锚点那一行高”', async () => {
    const { foldFrame } = await import('../hooks/useMonthFold.ts');
    // 六行：每行高 60、格缝 4（行距 64），第 2 行多一个节日名高 80（行距 84）；月格总高 6×60+20+5×4 = 400
    const tops = [0, 64, 128, 212, 276, 340];
    const g = { rows: tops.map((top, i) => ({ top, h: i === 2 ? 80 : 60 })), full: 400 };
    expect(foldFrame(g, 2, 0).row(0)).toBeNull();
    expect(foldFrame(g, 2, 0).cut).toBe(0);
    const f = foldFrame(g, 2, 1);
    // 锚点第 2 行：上面两行的行距 64 + 64 都收掉，正好顶到月格上沿
    expect(f.row(2)).toEqual({ transform: 'translateY(-128px)', opacity: '' });
    expect(f.cut).toBe(400 - 80);
    // 第 3 行：上面除了锚点那一行的行距（64 + 64）收掉，压扁、淡没
    expect(f.row(3)?.transform).toBe('translateY(-128px) scaleY(0.0001)');
    expect(f.row(3)?.opacity).toBe('0');
    // 进度一半：位移一半，字已经淡掉大半（淡得比压扁快）
    const h = foldFrame(g, 2, 0.5);
    expect(h.row(2)?.transform).toBe('translateY(-64px)');
    expect(Number(h.row(0)?.opacity)).toBeCloseTo(0, 5);
    expect(Number(foldFrame(g, 2, 0.2).row(0)?.opacity)).toBeCloseTo(0.56, 5);
    expect(h.cut).toBe(160);
  });

  it('电脑周视图：现在线排在日程块前面（画在块下面，不压字；设计复审 N2）', () => {
    stubWide();
    data.events = [ev('1', { date: '2026-11-05', time: '08:30', duration_min: 90 })];
    open('#/cal/week/2026-11-05');
    const now = screen.getByTestId('cal-now');
    expect(now.parentElement?.firstElementChild).toBe(now);
  });

  it('删掉的待办不撑宽时间轴；没完成的、已完成的（周历留着划线，负责人 11-21）照常撑（代码复审 N5）', () => {
    data.todos = [todo('b', { due_time: '06:30', deleted_at: 3 })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('8-22');
    cleanup();
    data.todos = [todo('a', { due_time: '05:30' })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('5-22');
    cleanup();
    data.todos = [todo('a', { due_time: '05:30', done: true })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('5-22');
  });

  it('勾完成的待办：周历留着、划删除线，当天读屏件数不算它；月历格子照旧不画（负责人 11-21）', () => {
    data.todos = [todo('a', { title: '确认热处理', due: '2026-11-04', done: true }), todo('b', { title: '买菜', due: '2026-11-04' })];
    open('#/cal/week/2026-11-02');
    const done = document.querySelector('[data-todo="a"]');
    expect(done?.hasAttribute('data-done')).toBe(true);
    expect(document.querySelector('[data-todo="b"]')?.hasAttribute('data-done')).toBe(false);
    cleanup();
    open('#/cal/month/2026-11');
    expect(screen.queryByText('确认热处理')).toBeNull();
  });

  it('跨午夜的日程：开始那天照常列出，次日清单最前面补一行续段“至 01:00”，件数也算上（代码复审 N6）', () => {
    data.events = [ev('1', { title: '通宵', date: '2026-11-09', time: '23:00', duration_min: 120 }), ev('2', { title: '早会', date: '2026-11-10', time: '09:00' })];
    open('#/cal/month/2026-11');
    fireEvent.click(cell('2026-11-09') as HTMLElement);
    // R-444：开始那天标题下面写到哪天几点
    expect(dayRows().map((b) => b.textContent)).toEqual(['23:00通宵至 11月10日 01:00']);
    fireEvent.click(cell('2026-11-10') as HTMLElement);
    const list = screen.getByTestId('cal-day-list');
    const rows = dayRows();
    expect(rows.map((b) => b.textContent)).toEqual(['至 01:00通宵', '09:00早会']);
    expect(rows[0]?.getAttribute('data-kind')).toBe('cont');
    expect(list.textContent).toContain('2 项');
    fireEvent.click(cell('2026-11-11') as HTMLElement);
    expect(screen.getByTestId('cal-day-list').textContent).toContain('这一天没有安排');
  });

  it('跨两天以上的（R-444）：中间整天写“持续”、标题下面写到哪天几点；最后一天“至 04:00”', () => {
    data.events = [ev('1', { title: '展会', date: '2026-11-09', time: '22:00', duration_min: 30 * 60 })];
    open('#/cal/month/2026-11');
    fireEvent.click(cell('2026-11-10') as HTMLElement);
    expect(dayRows().map((b) => b.textContent)).toEqual(['持续展会至 11月11日 04:00']);
    expect(dayRows()[0]?.getAttribute('data-kind')).toBe('cont');
    fireEvent.click(cell('2026-11-11') as HTMLElement);
    expect(dayRows().map((b) => b.textContent)).toEqual(['至 04:00展会']);
    fireEvent.click(cell('2026-11-12') as HTMLElement);
    expect(screen.getByTestId('cal-day-list').textContent).toContain('这一天没有安排');
  });

  it('全天跨 3 天（R-444）：三天的清单都有，标题下面写“第 N/3 天”；月格三天都有它', () => {
    data.events = [ev('1', { title: '出差', date: '2026-11-18', time: null, tz: null, duration_min: 3 * 1440 })];
    open('#/cal/month/2026-11');
    for (const [d, i] of [['2026-11-18', 1], ['2026-11-19', 2], ['2026-11-20', 3]] as const) {
      fireEvent.click(cell(d) as HTMLElement);
      expect(dayRows().map((b) => b.textContent)).toEqual([`全天出差第 ${i}/3 天`]);
    }
    fireEvent.click(cell('2026-11-21') as HTMLElement);
    expect(screen.getByTestId('cal-day-list').textContent).toContain('这一天没有安排');
  });

  it('电脑周表全天行（R-444）：跨 3 天的每天一块，标题后面写“(N/3)”（连条画法等负责人定图）', () => {
    stubWide();
    data.events = [ev('1', { title: '出差', date: '2026-11-18', time: null, tz: null, duration_min: 3 * 1440 })];
    open('#/cal/week/2026-11-18');
    expect(screen.getAllByTestId('cal-desk-all-1').map((b) => b.textContent)).toEqual(['出差 (1/3)', '出差 (2/3)', '出差 (3/3)']);
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
  it('点柄收起、弹簧才走一点就按住又被取消：最后停在收起（月格只排锚点那一行），aria-expanded 仍是 false、别的行仍 inert', () => {
    let now = 0;
    const q: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => q.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => q.splice(0));
    // 一帧一帧往前推（弹簧每帧最多算 32 ms）
    const flush = (at: number) => act(() => {
      for (let n = 0; q.length > 0 && now < at && n < 2000; n++) {
        now += 16;
        q.shift()?.(now);
      }
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
    // 停稳在收起：换成真的一行排布（data-folded），动画途中直接写上去的透明度、位移都清掉了（R-457 重写）
    expect(screen.getByTestId('cal-month').querySelector('[data-folded]')).not.toBeNull();
    expect(cell('2026-11-12')?.style.opacity).toBe('');
    expect(cell('2026-11-12')?.style.transform).toBe('');
  });

  it('收起途中的诊断（todo_drift）只在开始动、停稳两刻各量一次，不再每帧都量（11-20 改善报告第四节）；运行日志那一行照旧', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let now = 0;
    const q: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => q.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => q.splice(0));
    const slot = ((globalThis as unknown as Record<string, { q: Array<[number, string]> }>)['__lemoRunLog'] ??= { q: [] });
    slot.q = [];
    open('#/cal/month/2026-11');
    const day = screen.getByTestId('cal-month').parentElement?.querySelector('[data-testid="cal-todos"]')?.parentElement ?? null;
    const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    let frames = 0;
    fireEvent.click(screen.getByTestId('cal-fold'));
    act(() => {
      for (let n = 0; q.length > 0 && n < 2000; n++) {
        now += 16;
        frames += 1;
        q.shift()?.(now);
        vi.advanceTimersByTime(0); // 原来每帧排一个 0ms 任务去量，这里一起推
      }
    });
    const line = slot.q.map(([, l]) => l).find((l) => l.startsWith('cal fold open→folded via=tap'));
    expect(frames).toBeGreaterThan(10);
    expect(line).toMatch(/todo_drift=\d+ todo_tf=\d+\/[0-2]$/);
    // 量待办组和日清单的读数：每次量 2 个，最多两次（没有待办组时一次也不量），和帧数无关
    const sampled = reads.mock.contexts.filter((el) => el instanceof Element && (el.matches('[data-testid="cal-todos"]') || el === day)).length;
    expect(sampled).toBeLessThanOrEqual(4);
    reads.mockRestore();
    vi.useRealTimers();
  });
});

