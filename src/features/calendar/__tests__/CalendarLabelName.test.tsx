// 月历页·读屏名字以看得见的字开头（WCAG 2.5.3 Label in Name，axe label-content-name-mismatch；11-11 修，b2-axe 去掉 KNOWN）：
// 月格、手机泳道、电脑时间块；农历加载前后；中文、韩文。看得见的字按 axe 的取法（文本节点直接连起来），所以几段之间 DOM 里必须有空格
// 集合、节假日文件用替身；“今天”固定在 2026-11-05（周四）09:00；设置和替身同 CalendarReview.test.tsx（那边已近 300 行）
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

/** 格子里看得见的字：文本节点按 DOM 顺序直接连起来、空白并成一个（axe label-content-name-mismatch 也这样取：几段之间没有空格就会粘成一个词） */
const shown = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** 名字没有以“看得见的字 + sep”开头的日期格、泳道按钮（空数组 = 全对） */
const notStartShown = (sep: string): string[] =>
  Array.from(document.querySelectorAll('[data-testid="cal-month"] button[data-date], [data-testid="cal-week"] li[data-date] button'))
    .filter((b) => !(b.getAttribute('aria-label') ?? '').startsWith(`${shown(b)}${sep}`))
    .map((b) => `${shown(b)} => ${b.getAttribute('aria-label') ?? ''}`);

describe('读屏名字以看得见的字开头（WCAG 2.5.3 Label in Name，axe label-content-name-mismatch，11-11）', () => {
  it('月格：日期数字、事项简称、“+N”按显示顺序在前，再接日期、星期、件数；农历加载前后都对得上', async () => {
    let done: (m: typeof realLunar) => void = () => {};
    resetLunarForTest(() => new Promise((r) => (done = r)));
    data.events = [ev('1', { project: 'NEOX', time: '08:00' }), ev('2', { time: '10:00' }), ev('3', { time: '11:00' })];
    open('#/cal/month/2026-11');
    expect(cell('2026-11-10')?.getAttribute('aria-label')).toMatch(/^10 \S+ \S+ \+1，11月10日，周二，共 3 件，/);
    expect(cell('2026-11-12')?.getAttribute('aria-label')).toMatch(/^12，11月12日，周四，没有安排$/);
    expect(notStartShown('，')).toEqual([]);
    await act(async () => {
      done(realLunar);
    });
    const info = realLunar.lunarDayInfo('2026-11-12', 'zh-CN');
    await waitFor(() => expect(cell('2026-11-12')?.getAttribute('aria-label')).toMatch(new RegExp(`^12 ${info.solarTerm ?? info.lunar ?? '-'}，11月12日，周四，农历`)));
    expect(cell('2026-11-10')?.getAttribute('aria-label')).toMatch(/^10 \S+ \S+ \S+ \+1，11月10日，/);
    expect(notStartShown('，')).toEqual([]);
  });

  it('手机泳道：星期、日期、农历、色块简称、“+N”、件数、“逾”在前；星期不念两遍', async () => {
    data.events = [ev('9', { date: '2026-11-05', time: '10:00' })];
    data.todos = [todo('t1', { due: '2026-11-04' })];
    open('#/cal/week/2026-11-02');
    const l4 = () => document.querySelector('[data-testid="cal-week"] li[data-date="2026-11-04"]');
    await waitFor(() => expect(shown(l4())).toMatch(/^周三 4 \S+ 1 逾$/));
    const name = l4()?.querySelector('button')?.getAttribute('aria-label') ?? '';
    expect(name.startsWith(`${shown(l4())}，11月4日，共 1 件，有逾期的待办`)).toBe(true);
    expect(name.split('周三')).toHaveLength(2);
    expect(shown(document.querySelector('[data-testid="cal-week"] li[data-date="2026-11-05"]'))).toMatch(/^周四 5 \S+ 日程 1$/);
    expect(notStartShown('，')).toEqual([]);
  });

  it('电脑周视图时间块：简称和标题不同时名字先念简称', () => {
    stubWide();
    data.events = [ev('r1', { title: '交季度报告', short: '交报', date: '2026-11-03', time: '10:00' }), ev('r2', { title: '复盘', date: '2026-11-04', time: '10:00' })];
    open('#/cal/week/2026-11-02');
    expect(screen.getByTestId('cal-desk-block-r1').getAttribute('aria-label')).toBe('交报，交季度报告，10:00～11:00');
    expect(screen.getByTestId('cal-desk-block-r2').getAttribute('aria-label')).toBe('复盘，10:00～11:00');
  });

  it('韩文界面：月格、泳道同样以看得见的字开头（sep 是“, ”）', () => {
    uiStore.getState().setLocale('ko-KR');
    data.events = [ev('1', { date: '2026-11-05' })];
    open('#/cal/month/2026-11');
    expect(cell('2026-11-05')?.getAttribute('aria-label')).toMatch(/^5 \S+, 11월 5일, 목요일, 오늘, /);
    expect(notStartShown(', ')).toEqual([]);
    cleanup();
    open('#/cal/week/2026-11-02');
    expect(document.querySelector('[data-testid="cal-week"] li[data-date="2026-11-05"] button')?.getAttribute('aria-label')).toMatch(/^목요일 5 \S+ 1, 11월 5일, 오늘, /);
    expect(notStartShown(', ')).toEqual([]);
  });
});
