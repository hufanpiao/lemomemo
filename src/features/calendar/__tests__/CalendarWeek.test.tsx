// 月历页面·周视图、键盘、年月选择器（B2 FA-3 返工：代码审查 M1、M3、M6、L1、L3；设计审查 M1、M3、M5、M6、M7；负责人 11-04 时间轴自动伸缩）
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）09:00；界面语言中文（周一起始）；手机排布，轨道宽 336 px
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clearAllCollections, readonlyIds } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

type Row = { id: string } & Record<string, unknown>;
const data: { events: Row[]; todos: Row[]; settings: Row[] } = { events: [], todos: [], settings: [] };
const collections: Record<string, () => Row[]> = { events: () => data.events, todos: () => data.todos, settings: () => data.settings };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => collections[name]?.() ?? [],
}));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: async (): Promise<AppJson> => ({ kind: 'missing' }) }));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const { styles } = await import('./css-of.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);
const TRACK = 336;

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
const lane = (date: string) => document.querySelector<HTMLLIElement>(`[data-testid="cal-week"] li[data-date="${date}"]`);
const key = (k: string, target: Element | Document = document.body) => fireEvent.keyDown(target, { key: k });

/** 记下 ResizeObserver 正在看哪些元素 */
const observed = new Set<Element>();
class FakeRO {
  private els: Element[] = [];
  observe(el: Element): void {
    this.els.push(el);
    observed.add(el);
  }
  disconnect(): void {
    for (const el of this.els) observed.delete(el);
    this.els = [];
  }
  unobserve(): void {}
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: TRACK, height: 44, x: 0, y: 0, top: 0, left: 0, right: TRACK, bottom: 44, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal('ResizeObserver', FakeRO);
  observed.clear();
  data.events = [];
  data.todos = [];
  data.settings = [];
  resetHolidayCacheForTest();
  resetLunarForTest(async () => realLunar);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('周视图（手机排布）', () => {
  it('任一天落到那一周（地址不改，L4）；七条泳道；默认 8～22 点，色块按轨道宽排（12:00 在 4/14 处），显示简称', async () => {
    data.events = [ev('1', { title: '客户会', date: '2026-11-10', time: '12:00' })];
    open('#/cal/week/2026-11-12');
    const week = screen.getByTestId('cal-week');
    expect(week.querySelector('li[data-date]')?.getAttribute('data-date')).toBe('2026-11-09');
    expect(window.location.hash).toBe('#/cal/week/2026-11-12');
    expect(week.getAttribute('data-range')).toBe('8-22');
    expect(week.querySelectorAll('li[data-date]')).toHaveLength(7);
    const block = await within(week).findByText('客户');
    expect(block.style.left).toBe(`${(TRACK * 4) / 14}px`);
    expect(block.className).toContain(styles.wev);
  });

  it('时间轴按当周事项自动伸缩：有 6:30 开始的扩到 6 点，有 22:10 结束的扩到 23 点（负责人 11-04）', async () => {
    data.events = [ev('1', { date: '2026-11-10', time: '06:30', duration_min: 30 }), ev('2', { date: '2026-11-11', time: '21:40', duration_min: 30 })];
    open('#/cal/week/2026-11-09');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('6-23');
    // 刻度数字：每 2 小时，终点也标
    const ruler = Array.from(document.querySelectorAll(`.${styles.wrul ?? 'x'} span`), (s) => s.textContent);
    expect(ruler).toEqual(['6', '8', '10', '12', '14', '16', '18', '20', '22', '23']);
    cleanup();
    data.events = [];
    open('#/cal/week/2026-11-09');
    expect(screen.getByTestId('cal-week').getAttribute('data-range')).toBe('8-22');
  });

  it('今天那条泳道有现在线（9:00 在 1/14 处），别的泳道没有', () => {
    open('#/cal/week/2026-11-02');
    const now = within(lane('2026-11-05') as HTMLElement).getByTestId('cal-now');
    expect(now.style.left).toBe(`${(1 / 14) * 100}%`);
    expect(screen.getAllByTestId('cal-now')).toHaveLength(1);
  });

  it('待办画成空心圆、不算进色块；右边写当天共几项，有逾期待办加“逾”，读屏写“有逾期的待办”', () => {
    data.todos = [todo('t1', { due: '2026-11-04' }), todo('t2', { due: '2026-11-06', due_time: '15:00' })];
    open('#/cal/week/2026-11-02');
    const l4 = lane('2026-11-04') as HTMLElement;
    expect(l4.querySelector('[data-todo="t1"]')?.className).toContain(styles.wtd);
    expect(l4.querySelector(`.${styles.tdn ?? 'x'}`)?.textContent).toBe('1逾');
    expect(within(l4).getByRole('button').getAttribute('aria-label')).toContain('有逾期的待办');
    const l6 = lane('2026-11-06') as HTMLElement;
    expect((l6.querySelector('[data-todo="t2"]') as HTMLElement).style.left).toBe(`${(TRACK * 7) / 14}px`);
    expect(l6.querySelector(`.${styles.tdn ?? 'x'}`)?.textContent).toBe('1');
  });

  it('点一条泳道：选中那天（aria-pressed），下面清单列出当天全部；点清单一行打开编辑页（设计审查 M7）', async () => {
    data.events = [ev('1', { title: '客户会', date: '2026-11-03', time: '12:00' })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-day-list').getAttribute('data-date')).toBe('2026-11-05');
    const btn = within(lane('2026-11-03') as HTMLElement).getByRole('button');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    const list = screen.getByTestId('cal-day-list');
    expect(list.getAttribute('data-date')).toBe('2026-11-03');
    await act(async () => {
      fireEvent.click(within(list).getByText('客户会'));
    });
    expect(window.location.hash).toBe('#/event/1');
  });

  it('翻周后量宽的 ResizeObserver 挂到新的轨道上，旧的不再看（代码审查 M1）', async () => {
    open('#/cal/week/2026-11-02');
    const first = lane('2026-11-02')?.querySelector(`.${styles.trk ?? 'x'}`);
    expect(first && observed.has(first)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-next'));
    });
    expect(window.location.hash).toBe('#/cal/week/2026-11-09');
    const next = lane('2026-11-09')?.querySelector(`.${styles.trk ?? 'x'}`);
    expect(next && observed.has(next)).toBe(true);
    expect(first && observed.has(first)).toBe(false);
  });

  it('周 / 月 / 纪念日分段：本月切到本周；“纪念日”置灰、不跳占位页，点了出“纪念日即将推出”，几秒后收起（B2 全站视觉审查 A2）', async () => {
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-mode-week'));
    });
    expect(window.location.hash).toBe('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-title').textContent).toContain('11月2日–8日');
    const anniv = screen.getByTestId('cal-mode-anniv');
    expect(anniv.getAttribute('aria-disabled')).toBe('true');
    expect(anniv.getAttribute('aria-label')).toBe('纪念日（即将推出）');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        fireEvent.click(anniv);
      });
      expect(window.location.hash).toBe('#/cal/week/2026-11-02');
      const soon = screen.getByTestId('cal-anniv-soon');
      expect(soon.textContent).toBe('纪念日即将推出');
      expect(soon.closest('[role="status"]')).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId('cal-anniv-soon')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('只读行（FA-2 只读行界面；架构 0.27 第 1 点）', () => {
  afterEach(() => {
    clearAllCollections();
  });

  it('页顶“有 N 条重复事项要新版本才能完整显示”；日清单只读行行尾有标记，点了不进编辑页、出提示条；可写的照常打开', async () => {
    data.events = [ev('r1', { date: '2026-11-05', repeat: { freq: 'week' } }), ev('w1', { date: '2026-11-05', time: '11:00' })];
    data.todos = [todo('rt', { due: '2026-11-05', repeat: { freq: 'day' } })];
    readonlyIds('events').set([{ id: 'r1', ro: true }]);
    readonlyIds('todos').set([{ id: 'rt', ro: true }]);
    open('#/cal/month/2026-11');
    expect((await screen.findByTestId('cal-repeat')).textContent).toContain('有 2 条重复事项要新版本才能完整显示');
    expect((await screen.findByTestId('cal-ro-r1'))).toBeTruthy();
    expect((await screen.findByTestId('cal-ro-rt'))).toBeTruthy();
    expect(screen.queryByTestId('cal-ro-w1')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-day-row-r1'));
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    expect((await screen.findByTestId('cal-ro-toast')).textContent).toContain('这条要新版本才能修改');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-day-row-w1'));
    });
    expect(window.location.hash).toBe('#/event/w1');
  });

  it('电脑周视图（FA-2 审查第 2 条）：只读的时间块、全天行斜纹底（data-readonly），读屏名字后接“要更新到新版本才能修改”；点了拦下出提示条，可写的照常打开', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('min-width: 768px'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    data.events = [ev('r1', { date: '2026-11-05', repeat: { freq: 'week' } }), ev('w1', { date: '2026-11-05', time: '11:00' })];
    data.todos = [todo('rt', { due: '2026-11-05', repeat: { freq: 'day' } })];
    readonlyIds('events').set([{ id: 'r1', ro: true }]);
    readonlyIds('todos').set([{ id: 'rt', ro: true }]);
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week').getAttribute('data-layout')).toBe('desk');
    const blk = screen.getByTestId('cal-desk-block-r1');
    const all = screen.getByTestId('cal-desk-all-rt');
    const ok = screen.getByTestId('cal-desk-block-w1');
    expect(blk.hasAttribute('data-readonly')).toBe(true);
    expect(all.hasAttribute('data-readonly')).toBe(true);
    expect(ok.hasAttribute('data-readonly')).toBe(false);
    expect(blk.getAttribute('aria-label')).toMatch(/日程r1.*，要更新到新版本才能修改$/);
    expect(all.getAttribute('aria-label')).toMatch(/待办rt.*，要更新到新版本才能修改$/);
    expect(ok.getAttribute('aria-label')).not.toContain('新版本');
    await act(async () => {
      fireEvent.click(blk);
    });
    expect(window.location.hash).toBe('#/cal/week/2026-11-05');
    expect((await screen.findByTestId('cal-ro-toast')).getAttribute('role')).toBe('alert');
    await act(async () => {
      fireEvent.click(all);
    });
    expect(window.location.hash).toBe('#/cal/week/2026-11-05');
    await act(async () => {
      fireEvent.click(ok);
    });
    expect(window.location.hash).toBe('#/event/w1');
  });

  it('电脑周视图的时间块位置（视觉验收第 1 条核实）：23 点以后的、别的时区记的日程，都按设备时区画在对的那一格', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('min-width: 768px'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    const { minOfDay } = await import('../../../../shared/core/date.ts');
    const { DESK_HOUR_PX } = await import('../ui/DeskWeek.tsx');
    // 别的时区：取和设备差 1 小时的那一个（设备是首尔就用上海，否则用首尔），记成 22:40，换到设备时区再算期望的分钟
    const other = TZ === 'Asia/Seoul' ? 'Asia/Shanghai' : 'Asia/Seoul';
    data.events = [
      ev('late', { date: '2026-11-05', time: '23:40', duration_min: 15 }),
      ev('late2', { date: '2026-11-05', time: '23:00', duration_min: 50 }),
      ev('tzx', { date: '2026-11-05', time: '22:40', tz: other, duration_min: 10 }),
    ];
    open('#/cal/week/2026-11-05');
    const [h0] = (screen.getByTestId('cal-week').getAttribute('data-range') ?? '0-24').split('-').map(Number);
    const topOf = (min: number) => `${((min - (h0 ?? 0) * 60) / 60) * DESK_HOUR_PX}px`;
    expect(screen.getByTestId('cal-desk-block-late').style.top).toBe(topOf(23 * 60 + 40));
    expect(screen.getByTestId('cal-desk-block-late2').style.top).toBe(topOf(23 * 60));
    const tzMin = minOfDay(msAt('2026-11-05', 22 * 60 + 40, other), TZ);
    expect(screen.getByTestId('cal-desk-block-tzx').style.top).toBe(topOf(tzMin));
    expect(screen.getByTestId('cal-desk-block-late').getAttribute('aria-label')).toContain('23:40');
  });

  it('没有只读行：不出横幅、不出标记', () => {
    data.events = [ev('w1', { date: '2026-11-05', repeat: { freq: 'week' } })];
    open('#/cal/month/2026-11');
    expect(screen.queryByTestId('cal-repeat')).toBeNull();
    expect(screen.queryByTestId('cal-ro-w1')).toBeNull();
  });
});

describe('键盘（架构 5.12 第 3 点）', () => {
  it('→ 连按三次：只新增一条历史，停在 3 个月后；← 往回；T 回今天', async () => {
    open('#/cal/month/2026-11');
    const before = window.history.length;
    await act(async () => {
      key('ArrowRight');
      key('ArrowRight');
      key('ArrowRight');
    });
    expect(window.location.hash).toBe('#/cal/month/2027-02');
    expect(window.history.length).toBe(before + 1);
    await act(async () => {
      key('ArrowLeft');
    });
    expect(window.location.hash).toBe('#/cal/month/2027-01');
    await act(async () => {
      key('t');
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
  });

  it('焦点在输入框里、按着修饰键时不翻页', async () => {
    open('#/cal/month/2026-11');
    const input = document.createElement('input');
    document.body.append(input);
    await act(async () => {
      key('ArrowRight', input);
      fireEvent.keyDown(document.body, { key: 'ArrowRight', ctrlKey: true });
    });
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    input.remove();
  });
});

describe('年月选择器（Popover，线框 sYM）', () => {
  it('点标题胶囊弹出；焦点在正在看的月份；点 2030 年再点 5 月跳过去并收起', async () => {
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    const picker = await screen.findByTestId('cal-picker');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-month')).toBe('11'));
    const cur = picker.querySelector('[data-month="11"]');
    expect(cur?.className).toContain(styles.ymOn);
    expect(cur?.className).toContain(styles.ymCur);
    await act(async () => {
      fireEvent.click(picker.querySelector('[data-year="2030"]') as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(picker.querySelector('[data-month="5"]') as HTMLElement);
    });
    expect(window.location.hash).toBe('#/cal/month/2030-05');
    await waitFor(() => expect(screen.queryByTestId('cal-picker')).toBeNull());
  });

  it('月份格子里方向键移动焦点（← → 一格，↑ ↓ 一行），不翻页；Esc 收起、焦点回到胶囊', async () => {
    open('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    const picker = await screen.findByTestId('cal-picker');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-month')).toBe('11'));
    key('ArrowLeft', document.activeElement as Element);
    expect(document.activeElement?.getAttribute('data-month')).toBe('10');
    key('ArrowUp', document.activeElement as Element);
    expect(document.activeElement?.getAttribute('data-month')).toBe('7');
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    await act(async () => {
      fireEvent.keyDown(picker, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('cal-picker')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('cal-title'));
  });

  it('周视图里选月份跳到那个月 1 日所在的周；“回到今天”跳回本周（地址写今天）并收起', async () => {
    open('#/cal/week/2026-11-02');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    let picker = await screen.findByTestId('cal-picker');
    await act(async () => {
      fireEvent.click(picker.querySelector('[data-month="3"]') as HTMLElement);
    });
    expect(window.location.hash).toBe('#/cal/week/2026-02-23');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-title'));
    });
    picker = await screen.findByTestId('cal-picker');
    await act(async () => {
      fireEvent.click(within(picker).getByTestId('cal-picker-today'));
    });
    // 周视图回今天：地址写今天本身（L4）
    expect(window.location.hash).toBe('#/cal/week/2026-11-05');
  });
});
