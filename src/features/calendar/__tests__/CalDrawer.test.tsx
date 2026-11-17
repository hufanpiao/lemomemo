// 电脑版日历的详情抽屉（R-130“包括周视图、月视图”，11-17 接上；ui/CalDrawer.tsx、CalendarPage 的 useCalGuard）
// 集合用替身；日程、待办编辑器换成只画 id 的替身（真编辑器在 e2e 里跑）；“今天”固定在 2026-11-05（周四）09:00；中文界面
// 宽度用 matchMedia 替身：desk 为真时 MQ_SIDEBAR（width >= 900px）和月历宽屏都匹配，为假时只匹配月历宽屏（768～899 这一档照旧进编辑页）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const logs: string[] = [];
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (s: string) => void logs.push(s) }));
vi.mock('../index.ts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  EventDrawerEditor: ({ id }: { id: string }) => <p data-testid="fake-event-editor">{id}</p>,
}));
vi.mock('../../todos/index.ts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  TodoDrawerEditor: ({ id }: { id: string }) => <p data-testid="fake-todo-editor">{id}</p>,
}));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);

const ev = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `日程${id}`, short: null, project: '', date: '2026-11-05', time: '11:00', tz: TZ, duration_min: 60, created_at: 1, deleted_at: null, undone: false, ...over,
});
const todo = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `待办${id}`, short: null, project: '', due: '2026-11-05', due_time: null, done: false, created_at: 1, deleted_at: null, undone: false, ...over,
});

function width(desk: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 768px') || (desk && q.includes('900px')),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
}
function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 336, height: 44, x: 0, y: 0, top: 0, left: 0, right: 336, bottom: 44, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} unobserve(): void {} });
  data.events = [ev('e1')];
  data.todos = [todo('t1')];
  data.settings = [];
  logs.length = 0;
  resetHolidayCacheForTest();
});
afterEach(() => {
  cleanup();
  clearAllCollections();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('电脑版日历的详情抽屉（R-130）', () => {
  it('月视图日清单：点日程开右边抽屉（不换页、行 aria-current、日志一行不带标题）；点待办换成待办编辑器；× 由编辑器放，Esc 关上焦点回到那一行', async () => {
    width(true);
    open('#/cal/month/2026-11');
    const row = screen.getByTestId('cal-day-row-e1');
    expect(row.getAttribute('data-open')).toBe('e1');
    row.focus();
    await click(row);
    const drawer = screen.getByTestId('cal-drawer');
    expect(drawer.getAttribute('aria-label')).toBe('详情');
    expect(drawer.hasAttribute('data-side')).toBe(false);
    expect((await screen.findByTestId('fake-event-editor')).textContent).toBe('e1');
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(logs).toContain('cal drawer open kind=event view=month');
    expect(logs.join('\n')).not.toContain('日程e1');

    await click(await screen.findByTestId('cal-day-row-t1'));   // 待办组是懒加载的（R-443）
    expect((await screen.findByTestId('fake-todo-editor')).textContent).toBe('t1');
    expect(row.hasAttribute('aria-current')).toBe(false);
    expect(screen.getByTestId('cal-day-row-t1').getAttribute('aria-current')).toBe('true');

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    // 中途换过一条：焦点回到当前这一条的行（DetailDrawer 的规则，同今天页）
    expect(document.activeElement).toBe(screen.getByTestId('cal-day-row-t1'));

    // 只开一条：Esc 关上回到点开它的那一行
    row.focus();
    await click(row);
    expect(await screen.findByTestId('fake-event-editor')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('抽屉里删了这一条（行不在了）：关上时焦点退到页顶 h1，不掉到 body', async () => {
    width(true);
    const r = open('#/cal/month/2026-11');
    const row = screen.getByTestId('cal-day-row-e1');
    row.focus();
    await click(row);
    expect(await screen.findByTestId('fake-event-editor')).toBeTruthy();
    data.events = [];
    r.rerender(<CalendarPage />);
    expect(screen.queryByTestId('cal-day-row-e1')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('电脑周表：点时间块、全天行的待办开同一个抽屉（日志 view=week）', async () => {
    width(true);
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week').getAttribute('data-layout')).toBe('desk');
    const blk = screen.getByTestId('cal-desk-block-e1');
    expect(blk.getAttribute('data-open')).toBe('e1');
    await click(blk);
    expect((await screen.findByTestId('fake-event-editor')).textContent).toBe('e1');
    expect(blk.getAttribute('aria-current')).toBe('true');
    expect(logs).toContain('cal drawer open kind=event view=week');
    await click(screen.getByTestId('cal-desk-all-t1'));
    expect((await screen.findByTestId('fake-todo-editor')).textContent).toBe('t1');
    expect(window.location.hash).toBe('#/cal/week/2026-11-05');
  });

  it('只读行照旧拦下：不开抽屉、不换页，出“要新版本”提示条', async () => {
    width(true);
    data.events = [ev('r1', { repeat: { freq: 'week' } })];
    readonlyIds('events').set([{ id: 'r1', ro: true }]);
    open('#/cal/month/2026-11');
    await click(await screen.findByTestId('cal-day-row-r1'));
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    expect(window.location.hash).toBe('#/cal/month/2026-11');
    expect((await screen.findByTestId('cal-ro-toast')).textContent).toContain('这条要新版本才能修改');
    expect(logs.some((s) => s.startsWith('cal drawer'))).toBe(false);
  });

  it('手机宽度（和 768～899 这一档）不开抽屉，照旧进编辑页', async () => {
    width(false);
    open('#/cal/month/2026-11');
    await click(screen.getByTestId('cal-day-row-e1'));
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    expect(window.location.hash).toBe('#/event/e1');
    cleanup();
    open('#/cal/week/2026-11-05');
    await click(screen.getByTestId('cal-desk-block-e1'));
    expect(screen.queryByTestId('cal-drawer')).toBeNull();
    expect(window.location.hash).toBe('#/event/e1');
  });
});
