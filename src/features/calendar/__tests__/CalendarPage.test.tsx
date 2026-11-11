// 月历页面·月视图（B2 FA-3，架构 5.12；TC-B2-13～19 的页面一侧；FA-3 三份审查返工后的版本）
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）；界面语言中文（周一起始、显示中国节假日）
// 周视图、键盘、年月选择器见 CalendarWeek.test.tsx
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
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
const { MonthGrid } = await import('../ui/MonthGrid.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const { viewZh } = await import('../i18n/view-zh.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const { styles } = await import('./css-of.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);

const ev = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `日程${id}`, short: null, project: '', date: '2026-11-10', time: '09:00', tz: TZ, duration_min: 60, created_at: 1, deleted_at: null, undone: false, ...over,
});
const ok = (json: unknown): AppJson => ({ kind: 'ok', json });

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}

const cell = (date: string) => document.querySelector<HTMLButtonElement>(`[data-testid="cal-month"] [data-date="${date}"]`);

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
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
});

describe('月视图', () => {
  it('右上角头像是设置入口（R-381）：和月份胶囊在同一行的右端，不在翻页容器里（横滑翻页不吃掉它）；月视图、周视图都有', () => {
    open('#/calendar');
    const me = screen.getByTestId('cal-settings');
    expect(me.getAttribute('href')).toContain('#/settings');
    expect(me.getAttribute('aria-label')).toBe('设置');
    const row = me.parentElement;
    expect(row?.className).toBe(styles.top);
    expect(row?.contains(screen.getByTestId('cal-title'))).toBe(true);
    expect(row?.lastElementChild).toBe(me);
    expect(screen.getByTestId('cal-pager').contains(me)).toBe(false);
    cleanup();
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week')).toBeTruthy();
    expect(screen.getByTestId('cal-settings').closest('[data-testid="cal-pager"]')).toBeNull();
  });

  it('#/calendar：本月 42 格，周一起始；今天高亮；“今天”在本月时 aria-disabled（焦点不丢，不用 disabled）', () => {
    open('#/calendar');
    expect(screen.getByTestId('cal-title').textContent).toContain('2026年11月');
    expect(document.querySelectorAll('[data-testid="cal-month"] button[data-date]')).toHaveLength(42);
    expect(document.querySelector('[data-testid="cal-month"] button[data-date]')?.getAttribute('data-date')).toBe('2026-10-26');
    expect(cell('2026-11-05')?.className).toContain(styles.today);
    const tdy = screen.getByTestId('cal-today') as HTMLButtonElement;
    expect(tdy.disabled).toBe(false);
    expect(tdy.getAttribute('aria-disabled')).toBe('true');
  });

  it('读屏：日期、星期几、今天、共几件（设计审查 L3 / 代码审查 L10）', () => {
    data.events = [ev('1', { date: '2026-11-05' })];
    open('#/calendar');
    const label = cell('2026-11-05')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('11月5日');
    expect(label).toContain('周四');
    expect(label).toContain('今天');
    expect(label).toContain('共 1 件');
  });

  it('事件标签：一件事一个、按项目分色（块底色类）；手机每格 2 个，多出来写“+N”；读屏按项目汇总、写另有几件未显示；删掉的不算', () => {
    data.events = [
      ev('1', { project: 'NEOX', time: '08:00' }),
      ev('2', { project: 'NEOX', time: '10:00' }),
      ev('3', { project: '', time: '11:00' }),
      ev('4', { project: 'NEOX', deleted_at: 5 }),
    ];
    open('#/cal/month/2026-11');
    const c = cell('2026-11-10');
    if (!c) throw new Error('没有这一格');
    expect(within(c).getAllByText(/日程/)).toHaveLength(2);
    expect(within(c).getByText('+1')).toBeTruthy();
    const label = c.getAttribute('aria-label') ?? '';
    expect(label).toContain('NEOX 2 件');
    expect(label).toContain('未分项目 1 件');
    expect(label).toContain('共 3 件');
    expect(label).toContain('另有 1 件未显示');
    const mk = within(c).getAllByText(/日程/)[0];
    expect(mk?.className).toContain(styles.mark);
    expect(mk?.className).toContain(styles[`c${projectColorIndex('NEOX')}`] ?? 'x');
    expect(cell('2026-11-11')?.getAttribute('aria-label')).toContain('没有安排');
  });

  it('节假日：拉到文件就标出名字和灰底；补班另标；周末、节日名不另上颜色（设计审查 M4）', async () => {
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/cn/2026.json'
        ? ok({ country: 'cn', year: 2026, days: [{ date: '2026-11-11', kind: 'off', name: { zh: '测试假' } }, { date: '2026-11-14', kind: 'work', name: { zh: '测试假' } }] })
        : { kind: 'missing' },
    );
    open('#/cal/month/2026-11');
    await waitFor(() => expect(cell('2026-11-11')?.textContent).toContain('测试假'));
    expect(fetchStatus).toHaveBeenCalledWith('holidays/cn/2026.json');
    expect(cell('2026-11-11')?.className).toContain(styles.holiday);
    expect(cell('2026-11-14')?.textContent).toContain('班');
    expect(cell('2026-11-14')?.getAttribute('aria-label')).toContain('测试假（补班）');
    expect(screen.queryByTestId('cal-offline')).toBeNull();
    expect(Object.keys(styles)).not.toContain('weekend');
  });

  it('离线没拉到节假日：提示“联网后显示节假日”；不记死，online 事件后重拉、提示消失（代码审查 M2、安全 FA3-4）', async () => {
    fetchStatus.mockResolvedValue({ kind: 'failed' });
    open('#/cal/month/2026-11');
    expect((await screen.findByTestId('cal-offline')).textContent).toBe(viewZh['cal.offline']);
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/cn/2026.json' ? ok({ country: 'cn', year: 2026, days: [{ date: '2026-11-11', kind: 'off', name: { zh: '测试假' } }] }) : { kind: 'missing' },
    );
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(cell('2026-11-11')?.textContent).toContain('测试假'));
    expect(screen.queryByTestId('cal-offline')).toBeNull();
  });

  it('服务器明确没有（404）：不提示离线、也不重拉', async () => {
    open('#/cal/month/2026-11');
    // 11、12 月会顺带拉下一年（年末几格属于下一年）
    await waitFor(() => expect(fetchStatus.mock.calls.map((c) => c[0])).toEqual(['holidays/cn/2026.json', 'holidays/cn/2027.json']));
    expect(screen.queryByTestId('cal-offline')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('两国都显示：本国节日写在第一行，另一国小一号写在第二行（R-97）', async () => {
    data.settings = [{ id: 's2', key: 'cal.holidays', value: 'both', deleted_at: null, undone: false }];
    fetchStatus.mockImplementation(async (p: string) =>
      p === 'holidays/cn/2026.json'
        ? ok({ country: 'cn', year: 2026, days: [{ date: '2026-11-11', kind: 'off', name: { zh: '中国假' } }] })
        : p === 'holidays/kr/2026.json'
          ? ok({ country: 'kr', year: 2026, days: [{ date: '2026-11-11', kind: 'off', name: { zh: '韩国假', ko: '한국휴일' } }] })
          : { kind: 'missing' },
    );
    open('#/cal/month/2026-11');
    await waitFor(() => expect(cell('2026-11-11')?.querySelector(`.${styles.hol2 ?? 'x'}`)?.textContent).toBe('韩国假'));
    expect(cell('2026-11-11')?.querySelector(`.${styles.holName ?? 'x'}`)?.textContent).toBe('中国假');
  });

  it('图例常驻：节假日国家（跟设置）、标签、+N、纪念日（线框 s3）', () => {
    open('#/cal/month/2026-11');
    const lg = screen.getByTestId('cal-legend');
    expect(lg.textContent).toContain('中国');
    expect(lg.textContent).toContain('+N');
    expect(lg.textContent).toContain('纪念日');
  });

  it('翻页改地址；非法月份换成本月（replace）；到 1900-01 时“上个月”aria-disabled、点了不动（代码审查 L1）', async () => {
    open('#/cal/month/2026-13');
    await waitFor(() => expect(window.location.hash).toBe('#/cal/month/2026-11'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-12');
    cleanup();
    open('#/cal/month/1900-01');
    const prev = screen.getByTestId('cal-prev');
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(prev);
    });
    expect(window.location.hash).toBe('#/cal/month/1900-01');
    expect(screen.getByTestId('cal-today').getAttribute('aria-disabled')).toBeNull();
  });

  it('点一格：选中那天（aria-pressed），下面清单列出当天全部日程和待办；默认选中今天；点清单一行打开编辑页（设计审查 M2）', async () => {
    data.events = [ev('1', { title: '客户会', date: '2026-11-12', time: '14:00' }), ev('2', { title: '团建', date: '2026-11-12', time: null, duration_min: null })];
    data.todos = [{ id: 't1', title: '交报告', short: null, project: '', due: '2026-11-12', due_time: '18:00', done: false, created_at: 1, deleted_at: null, undone: false }];
    open('#/cal/month/2026-11');
    expect(screen.getByTestId('cal-day-list').getAttribute('data-date')).toBe('2026-11-05');
    fireEvent.click(cell('2026-11-12') as HTMLElement);
    expect(cell('2026-11-12')?.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    const list = screen.getByTestId('cal-day-list');
    expect(list.getAttribute('data-date')).toBe('2026-11-12');
    expect(list.textContent).toContain('11月12日');
    expect(list.textContent).toContain('周四');
    expect(list.textContent).toContain('3 项');
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['14:00客户会', '全天团建', '18:00交报告']);
    await act(async () => {
      fireEvent.click(rows[0] as HTMLElement);
    });
    expect(window.location.hash).toBe('#/event/1');
  });

  it('纪念日：文字行后面画菱形，读屏写“有纪念日”（R-105；纪念日数据 B5 接入前用月格直接验）', () => {
    const t = (k: string, v: Record<string, string | number>) => (viewZh as Record<string, string>)[k]?.replace(/\{(\w+)\}/g, (_, n: string) => String(v[n] ?? '')) ?? k;
    render(
      <MonthGrid
        cells={[{ date: '2026-11-05', inMonth: true, isToday: false, weekday: 4, holidays: [], marks: [], more: 0, a11y: [], anniv: true }]}
        weekStart={1}
        t={t as never}
        label="x"
        selected={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId('cal-anniv').className).toContain(styles.dia);
    expect(document.querySelector('[data-date="2026-11-05"]')?.getAttribute('aria-label')).toContain('有纪念日');
  });
});

describe('设置 › 日历 的两项（cal.week_start、cal.holidays）', () => {
  it('周日起始：月格从周日开始；周参数落到周日起始的那一周、地址不改（L4）', async () => {
    data.settings = [{ id: 's1', key: 'cal.week_start', value: 0, deleted_at: null, undone: false }];
    open('#/cal/month/2026-11');
    expect(document.querySelector('[data-testid="cal-month"] button[data-date]')?.getAttribute('data-date')).toBe('2026-11-01');
    cleanup();
    open('#/cal/week/2026-11-05');
    expect(document.querySelector('[data-testid="cal-week"] li[data-date]')?.getAttribute('data-date')).toBe('2026-11-01');
    expect(window.location.hash).toBe('#/cal/week/2026-11-05');
  });

  it('中文界面选了“只显示韩国”：只拉韩国的文件；“两国都显示”：两国都拉', async () => {
    data.settings = [{ id: 's2', key: 'cal.holidays', value: 'kr', deleted_at: null, undone: false }];
    open('#/cal/month/2026-06');
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith('holidays/kr/2026.json'));
    expect(fetchStatus).not.toHaveBeenCalledWith('holidays/cn/2026.json');
    cleanup();
    fetchStatus.mockClear();
    resetHolidayCacheForTest();
    data.settings = [{ id: 's2', key: 'cal.holidays', value: 'both', deleted_at: null, undone: false }];
    open('#/cal/month/2026-06');
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith('holidays/cn/2026.json'));
    expect(fetchStatus).toHaveBeenCalledWith('holidays/kr/2026.json');
  });
});

describe('农历（按需加载）', () => {
  const lunarRow = (date: string) => cell(date)?.querySelector(`.${styles.lunar ?? 'x'}`) ?? null;
  const D = '2026-11-12';

  it('加载前：照常 42 格，农历行位置占着但是空的；加载后格子显示短写法，读屏带完整写法', async () => {
    let done: (m: typeof realLunar) => void = () => {};
    resetLunarForTest(() => new Promise((r) => (done = r)));
    open('#/cal/month/2026-11');
    expect(document.querySelectorAll('[data-testid="cal-month"] button[data-date]')).toHaveLength(42);
    expect(lunarRow(D)?.textContent).toBe('');
    expect(cell(D)?.getAttribute('aria-label')).not.toContain('农历');
    await act(async () => {
      done(realLunar);
    });
    const info = realLunar.lunarDayInfo(D, 'zh-CN');
    const l = realLunar.toLunar(D, 'cn');
    if (!l || !info.lunar) throw new Error('农历数据缺这一天');
    await waitFor(() => expect(lunarRow(D)?.textContent).toBe(info.solarTerm ?? info.lunar));
    expect(cell(D)?.getAttribute('aria-label')).toContain(`农历${realLunar.lunarText(l, 'zh-CN')}`);
  });

  it('初一显示月名；节气那天显示节气名，读屏两样都有', async () => {
    open('#/cal/month/2026-11');
    const dates = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="cal-month"] button[data-date]'), (b) => b.dataset.date ?? '');
    const first = dates.find((d) => realLunar.toLunar(d, 'cn')?.day === 1 && realLunar.solarTermOf(d, 'cn') === null);
    const term = dates.find((d) => realLunar.solarTermOf(d, 'cn') !== null);
    if (!first || !term) throw new Error('这个月格里没有初一或节气');
    const l = realLunar.toLunar(first, 'cn');
    if (!l) throw new Error('农历数据缺这一天');
    await waitFor(() => expect(lunarRow(first)?.textContent).toBe(realLunar.lunarMonthName(l.month, l.isLeap, 'zh-CN')));
    const name = realLunar.lunarDayInfo(term, 'zh-CN').solarTerm ?? '';
    expect(lunarRow(term)?.textContent).toBe(name);
    expect(cell(term)?.getAttribute('aria-label')).toContain(name);
    expect(cell(term)?.getAttribute('aria-label')).toContain('农历');
  });

  it('加载失败：不报错、月格照常，没有农历行；之后翻页也不再加载', async () => {
    const load = vi.fn(async (): Promise<typeof realLunar> => {
      throw new Error('chunk 加载失败');
    });
    resetLunarForTest(load);
    open('#/cal/month/2026-11');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelectorAll('[data-testid="cal-month"] button[data-date]')).toHaveLength(42);
    expect(lunarRow(D)?.textContent).toBe('');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('韩文界面：不下农历 chunk，月格不显示农历、也不显示节气，读屏不带“음력”（代码审查 L7）', async () => {
    const load = vi.fn(async () => realLunar);
    resetLunarForTest(load);
    uiStore.getState().setLocale('ko-KR');
    open('#/cal/month/2026-11');
    await new Promise((r) => setTimeout(r, 20));
    expect(load).not.toHaveBeenCalled();
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid="cal-month"] button[data-date]')) {
      expect(b.getAttribute('aria-label')).not.toContain('음력');
      expect(lunarRow(b.dataset.date ?? '')?.textContent).toBe('');
    }
    expect(cell('2026-11-05')?.getAttribute('aria-label')).toContain('목요일');
  });

  it('范围外（1901-01-20 以前）没有农历行', async () => {
    open('#/cal/month/1900-01');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('cal-title').textContent).toContain('1900年1月');
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid="cal-month"] button[data-date]')) {
      expect(lunarRow(b.dataset.date ?? '')?.textContent).toBe('');
      expect(b.getAttribute('aria-label')).not.toContain('农历');
    }
  });
});
