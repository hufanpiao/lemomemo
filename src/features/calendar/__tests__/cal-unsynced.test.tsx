// 日历页的“未同步”提示和日清单行尾标记（REMIND-wiring；TC-B2-69、架构 4.2；reminders 的 UnsyncedRemindHint / UnsyncedRemindMark 懒加载）
// • 带提醒、还没同步上的记录（outbox 状态 remindRecs，`${table}:${id}`）：日清单那一行行尾标“未同步”，翻页按钮下面出一行“未同步，提醒可能不响”
// • 同步上（remindRecs 里没了）：标记和提示自动消失，空格子不占位
// • 周视图泳道、月格不标（定稿线框 s2、s3 没有这个标记）
// outbox 用替身（core/boot 的 getBoot），集合、节假日文件同 CalendarPage.test.tsx；“今天”固定在 2026-11-05（周四）
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import type * as BootMod from '../../../core/boot.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

type Row = { id: string } & Record<string, unknown>;
const data: { events: Row[]; todos: Row[]; settings: Row[] } = { events: [], todos: [], settings: [] };
const collections: Record<string, () => Row[]> = { events: () => data.events, todos: () => data.todos, settings: () => data.settings };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => collections[name]?.() ?? [],
}));
const fetchStatus = vi.fn(async (_p: string): Promise<AppJson> => ({ kind: 'missing' }));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: (p: string) => fetchStatus(p) }));

/** outbox 替身：remindRecs 可改，改了通知订阅者（同真 outbox 的 getStatus 换新对象） */
const box = {
  recs: new Set<string>() as ReadonlySet<string>,
  subs: new Set<() => void>(),
  set(next: string[]) {
    box.recs = new Set(next);
    for (const f of [...box.subs]) f();
  },
};
const outbox = {
  subscribe(fn: () => void) {
    box.subs.add(fn);
    return () => {
      box.subs.delete(fn);
    };
  },
  getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs: box.recs }),
};
vi.mock('../../../core/boot.ts', async (orig) => ({ ...(await orig<typeof BootMod>()), getBoot: () => ({ outbox }) }));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);
const ev = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `日程${id}`, short: null, project: '', date: '2026-11-05', time: '10:00', tz: TZ, duration_min: 60, created_at: 1, deleted_at: null, undone: false, ...over,
});
const td = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `待办${id}`, short: null, project: '', due: '2026-11-05', due_time: null, done: false, created_at: 1, deleted_at: null, undone: false, ...over,
});

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const rows = (): HTMLElement[] => within(screen.getByTestId('cal-day-list')).getAllByRole('button');
const rowOf = (title: string): HTMLElement => {
  const r = rows().find((b) => (b.textContent ?? '').includes(title));
  if (!r) throw new Error(`没有“${title}”这一行`);
  return r;
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  data.events = [ev('e1'), ev('e2', { time: '14:00' })];
  data.todos = [td('t1')];
  data.settings = [];
  box.recs = new Set();
  box.subs.clear();
  fetchStatus.mockReset();
  fetchStatus.mockResolvedValue({ kind: 'missing' });
  resetHolidayCacheForTest();
  resetLunarForTest(async () => realLunar);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('日清单行尾“未同步”小标记', () => {
  it('只标没同步上的那几条（日程按 events、待办按 todos 对），其余行不标；行的读屏名带上“未同步”', async () => {
    box.recs = new Set(['events:e2', 'todos:t1']);
    open('#/calendar');
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(2));
    expect(within(rowOf('日程e2')).getByTestId('remind-unsynced-mark').textContent).toBe('未同步');
    expect(within(rowOf('待办t1')).getByTestId('remind-unsynced-mark')).toBeTruthy();
    expect(within(rowOf('日程e1')).queryByTestId('remind-unsynced-mark')).toBeNull();
    // 标记在标题后面（行尾）
    const r = rowOf('日程e2');
    expect(r.lastElementChild?.contains(within(r).getByTestId('remind-unsynced-mark'))).toBe(true);
    expect(r.textContent).toContain('未同步');
  });

  it('表名要对上：events 里同 id 的不会去标待办', async () => {
    data.todos = [td('x')];
    data.events = [ev('e1')];
    box.recs = new Set(['events:x']);
    open('#/calendar');
    await screen.findByText('待办x');
    // 等懒加载的组件出来（另一条以 events 为准的同样不会标）
    await act(async () => {
      box.set(['events:x', 'events:e1']);
    });
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(1));
    expect(within(rowOf('待办x')).queryByTestId('remind-unsynced-mark')).toBeNull();
    expect(within(rowOf('日程e1')).getByTestId('remind-unsynced-mark')).toBeTruthy();
  });

  it('跨午夜日程在次日的续段行也标（同一条日程）', async () => {
    data.events = [ev('late', { date: '2026-11-04', time: '23:00', duration_min: 120 })];
    data.todos = [];
    box.recs = new Set(['events:late']);
    open('#/calendar');
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(1));
    const cont = rows().find((b) => b.getAttribute('data-kind') === 'cont');
    expect(cont).toBeTruthy();
    expect(within(cont as HTMLElement).getByTestId('remind-unsynced-mark')).toBeTruthy();
    // 续段行的标记也在最后（代码审查 L6，拦住把标记挪到标题前的变异 M13）
    expect((cont as HTMLElement).lastElementChild?.contains(within(cont as HTMLElement).getByTestId('remind-unsynced-mark'))).toBe(true);
  });

  it('同步上以后自动消失，行尾那一格不占位（没有空的标记格）', async () => {
    box.recs = new Set(['events:e1']);
    open('#/calendar');
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(1));
    await act(async () => {
      box.set([]);
    });
    await waitFor(() => expect(screen.queryByTestId('remind-unsynced-mark')).toBeNull());
    // 每行标记那一格都空着（CSS 里 :empty 不画，不多出一个 gap）
    const cells = document.querySelectorAll('[data-testid="cal-day-list"] .unsynced');
    expect(cells).toHaveLength(rows().length);
    for (const c of cells) expect(c.childNodes).toHaveLength(0);
  });

  it('周视图泳道不标（线框 s2 没有这个标记），下面的日清单照样标', async () => {
    box.recs = new Set(['events:e1']);
    open('#/cal/week/2026-11-05');
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(1));
    const list = screen.getByTestId('cal-day-list');
    expect(list.contains(screen.getByTestId('remind-unsynced-mark'))).toBe(true);
  });

  it('月格不标', async () => {
    box.recs = new Set(['events:e1']);
    open('#/calendar');
    await waitFor(() => expect(screen.getAllByTestId('remind-unsynced-mark')).toHaveLength(1));
    expect(within(screen.getByTestId('cal-month')).queryByTestId('remind-unsynced-mark')).toBeNull();
  });
});

describe('“未同步，提醒可能不响”一行', () => {
  it('有没同步上的带提醒记录时出在翻页按钮下面、正文上面；不在当天清单里的记录也算', async () => {
    box.recs = new Set(['events:somewhere-else']);
    open('#/calendar');
    const hint = await screen.findByTestId('remind-unsynced-hint');
    expect(hint.textContent).toBe('未同步，提醒可能不响');
    // 读屏播报靠常驻的 status 容器（代码审查 L3）：提示自己不带 role，装在 cal-notice 里
    expect(hint.getAttribute('role')).toBeNull();
    expect(hint.closest('[role="status"]')).toBe(screen.getByTestId('cal-notice'));
    const pager = screen.getByTestId('cal-pager');
    expect(hint.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const nav = screen.getByTestId('cal-today');
    expect(nav.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 当天清单里没有这条，行尾不标
    expect(screen.queryByTestId('remind-unsynced-mark')).toBeNull();
  });

  it('L3：status 容器先挂好、空着，内容后填进去（同一个节点，不是连内容一起插进来）', async () => {
    open('#/calendar');
    const notice = await screen.findByTestId('cal-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.childNodes).toHaveLength(0);
    await act(async () => {
      box.set(['todos:t1']);
    });
    const hint = await screen.findByTestId('remind-unsynced-hint');
    expect(hint.parentElement).toBe(notice);
    expect(screen.getByTestId('cal-notice')).toBe(notice);
  });

  it('L3：离线提示和未同步提示同时出现时是同一块里的两行，不叠成两块', async () => {
    fetchStatus.mockResolvedValue({ kind: 'failed' });
    box.recs = new Set(['todos:t1']);
    open('#/calendar');
    const off = await screen.findByTestId('cal-offline');
    const hint = await screen.findByTestId('remind-unsynced-hint');
    const notice = screen.getByTestId('cal-notice');
    expect(off.parentElement).toBe(notice);
    expect(hint.parentElement).toBe(notice);
    expect(off.className).toBe('');
    expect(screen.getAllByRole('status')).toEqual([notice]);
  });

  it('都同步上了：提示消失，外面那一格变空（CSS 里没有 p 不画，不占位）', async () => {
    box.recs = new Set(['todos:t1']);
    open('#/calendar');
    const hint = await screen.findByTestId('remind-unsynced-hint');
    const wrap = hint.parentElement as HTMLElement;
    expect(wrap).toBe(screen.getByTestId('cal-notice'));
    await act(async () => {
      box.set([]);
    });
    await waitFor(() => expect(screen.queryByTestId('remind-unsynced-hint')).toBeNull());
    expect(wrap.childNodes).toHaveLength(0);
  });

  it('没有没同步上的：不出提示', async () => {
    open('#/calendar');
    await screen.findByText('日程e1');
    // 给懒加载留时间：等标记组件能出来的时刻再看
    await act(async () => {
      box.set([]);
    });
    expect(screen.queryByTestId('remind-unsynced-hint')).toBeNull();
  });
});
