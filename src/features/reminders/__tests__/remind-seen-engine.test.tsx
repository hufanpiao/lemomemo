// 引擎接本机“响过”记录（REMIND-shown-persist；方案第 9 节第 1、2、3、4、6、9 条）：
// • 重开 App（重新挂引擎，库里留着 remind_seen）：全天日程 07:00 响过没处理，改成 07:20 以后横幅不再响，“错过的提醒”按 07:00
// • 本机没记录、服务器 pushed_for 是当天的：改了默认时刻不响；pushed_for 和这一次 tag 相同照旧响（R-52）；outbox 里有改日期的不采信
// • exe：弹过本机通知的马上写库，关掉重开 60 分钟内不再弹
// • 读失败照常 armed；armed 之前不排横幅；写库失败放回、下一分钟再写（L10）；本机弹过的撤回又撤销不再弹（L12）
// 替身同 RemindEngine.test.tsx，getBoot 多一个真的本机库（假 IndexedDB）
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { openCache, type Cache } from '../../../core/cache.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { remindQueue, resetRemindQueue, setRemindArmed } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: async () => 'saved' }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
let nowMs = 0;
const subs = new Set<() => void>();
vi.mock('../../../platform/clock.ts', () => ({
  clock: {
    now: () => nowMs,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    offset: () => 0,
    isClockWrong: () => false,
  },
}));
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined, isKeyboardOpen: () => false }));
const showLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: (...a: unknown[]) => showLocalReminder(...a),
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: vi.fn() }));
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
let cache: Cache | { tx: () => Promise<never> } | null = null;
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    cache,
    outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs: EMPTY_RECS }), list: async () => outboxList },
  }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { default: MissedReminders } = await import('../ui/MissedReminders.tsx');
const { rangSnapshot } = await import('../hooks/remind-list.ts');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const A1 = '00000000-0000-4000-8000-0000000000a1';
const E1 = '00000000-0000-4000-8000-000000000001';
const allDay = (over: Record<string, unknown> = {}): Row => ({
  id: A1, title: '体检', date: DAY, time: null, tz: null, remind_days: 0, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null, pushed_for: null, ...over,
});
const defaultTime = (v: string): Row => ({ id: 's1', key: 'remind.default_time', value: v, deleted_at: null });
const key = `event:${A1}:allday:${DAY}:0`;
/** 快照里这一次当时响的时刻（快照的值也可能是旧写法的 tag 字符串） */
const rangDue = (k: string): number | undefined => {
  const v = rangSnapshot().get(k);
  return typeof v === 'string' ? undefined : v?.dueAt;
};

/** 读库、算第一份快照、写库都是异步的（假 IndexedDB 走宏任务）：排几轮宏任务 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
  });
const tick = async (hm: string): Promise<void> => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
  await settle();
};
const freshCache = async (): Promise<Cache> => {
  const r = await openCache({ factory: fakeIndexedDB().factory });
  if (!r.ok) throw new Error('open');
  return r.cache;
};

beforeEach(async () => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [];
  data.todos = [];
  data.settings = [];
  outboxList = [];
  cache = await freshCache();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  showLocalReminder.mockClear();
});
afterEach(() => {
  cleanup();
  setRemindArmed(null);
});

describe('重开 App：本机记录（第 9 节第 1、6 条）', () => {
  it('全天日程 07:00 响过、没处理；关掉（pagehide 写库），改成 07:20 后重开：横幅不响，“错过的提醒”第一次显示就是 07:00 那一次', async () => {
    data.events = [allDay()];
    data.settings = [defaultTime('07:00')];
    nowMs = at('06:50');
    const first = render(<RemindHost route="todos" since={at('06:50')} />);
    await settle();
    await tick('07:01');
    expect(remindQueue.getState().entries.map((e) => e.id)).toEqual([A1]);
    act(() => {
      dispatchEvent(new Event('pagehide'));
    });
    await settle();
    first.unmount();
    resetRemindQueue();

    data.settings = [defaultTime('07:20')];
    nowMs = at('07:10');
    render(<RemindHost route="todos" since={at('07:10')} />);
    expect(remindQueue.getState().armedSince).toBeNull(); // 读完本机记录以前不 armed
    await settle();
    expect(remindQueue.getState().armedSince).toBe(at('07:10'));
    expect(rangDue(key)).toBe(at('07:00'));
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 1 条提醒');
    await tick('07:21');
    expect(remindQueue.getState().entries).toEqual([]); // 07:20 那一下不再进横幅（R-336）
  });

  it('读本机记录慢（armed 之前）：其间改成 07:20、到了 07:21 也不排横幅；读完以后按 07:00 那一次算响过，照旧不响', async () => {
    const real = await freshCache();
    const { writeSeen } = await import('../data/remind-seen.ts');
    await writeSeen(real, { [key]: { tag: `event:${A1}:${at('07:00')}`, dueAt: at('07:00'), local: false } }, at('07:05'));
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    cache = { tx: (async (...a: Parameters<Cache['tx']>) => {
      await gate;
      return real.tx(...a);
    }) as unknown as () => Promise<never> };
    data.events = [allDay()];
    data.settings = [defaultTime('07:20')];
    nowMs = at('07:10');
    render(<RemindHost route="todos" since={at('07:10')} />);
    await tick('07:21');
    expect(remindQueue.getState().armedSince).toBeNull();
    expect(remindQueue.getState().entries).toEqual([]);
    open();
    await settle();
    expect(remindQueue.getState().armedSince).toBe(at('07:10'));
    await tick('07:22');
    expect(remindQueue.getState().entries).toEqual([]);
  });

  it('读本机记录失败：当空的、照常 armed', async () => {
    cache = { tx: () => Promise.reject(new Error('blocked')) };
    data.events = [allDay()];
    data.settings = [defaultTime('07:00')];
    nowMs = at('06:50');
    render(<RemindHost route="todos" since={at('06:50')} />);
    await settle();
    expect(remindQueue.getState().armedSince).toBe(at('06:50'));
    await tick('07:01');
    expect(remindQueue.getState().entries.map((e) => e.id)).toEqual([A1]);
  });
});

describe('服务器 pushed_for（第 9 节第 2、3 条）', () => {
  it('本机没记录、手机 07:00 推过、改成 07:20：不响，“错过的提醒”按 07:00', async () => {
    data.events = [allDay({ pushed_for: at('07:00') })];
    data.settings = [defaultTime('07:20')];
    nowMs = at('07:15');
    render(<RemindHost route="todos" since={at('07:15')} />);
    await settle();
    await tick('07:21');
    expect(remindQueue.getState().entries).toEqual([]);
    expect(rangDue(key)).toBe(at('07:00'));
    render(<MissedReminders />);
    expect(screen.getByTestId('remind-missed-row').textContent).toContain('错过 1 条提醒');
  });

  it('pushed_for 和这一次 tag 相同（服务器推过、默认时刻没改）：照旧响（R-52 两边都响）', async () => {
    data.events = [allDay({ pushed_for: at('07:20') })];
    data.settings = [defaultTime('07:20')];
    nowMs = at('07:15');
    render(<RemindHost route="todos" since={at('07:15')} />);
    await settle();
    await tick('07:21');
    expect(remindQueue.getState().entries.map((e) => e.id)).toEqual([A1]);
    // exe 本机通知也照旧弹（代码审查一 L11）
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
    expect(showLocalReminder.mock.calls[0]?.[0]).toMatchObject({ tag: `event:${A1}:${at('07:20')}`, occurrenceKey: key });
  });

  it('outbox 里有挪日期、还没确认的改动：不采信 pushed_for，新的那一次照响', async () => {
    data.events = [allDay({ pushed_for: at('07:00') })];
    data.settings = [defaultTime('07:20')];
    outboxList = [{ rec: `events:${A1}`, op: 'patch', state: 'inflight', sent: true, data: { date: DAY, notified_for: null } }];
    nowMs = at('07:15');
    render(<RemindHost route="todos" since={at('07:15')} />);
    await settle();
    await tick('07:21');
    expect(remindQueue.getState().entries.map((e) => e.id)).toEqual([A1]);
  });
});

describe('exe 本机通知（第 9 节第 1、9 条）', () => {
  const timed = (): Row => ({
    id: E1, title: '和 Kim 开会', date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
    notified_for: null, snooze_at: null, defer_until: null,
  });

  it('弹出当下就写库（local: true）；马上关掉重开，60 分钟内不再弹；通知带 occurrenceKey', async () => {
    data.events = [timed()];
    nowMs = at('15:00');
    const first = render(<RemindHost route="todos" since={at('15:00')} />);
    await settle();
    await tick('15:16');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
    expect(showLocalReminder.mock.calls[0]?.[0]).toMatchObject({ occurrenceKey: `event:${E1}:${at('15:15')}` });
    first.unmount(); // 没有 pagehide、也没等到下一分钟：靠“弹出当下就写”
    resetRemindQueue();
    nowMs = at('15:20');
    render(<RemindHost route="todos" since={at('15:20')} />);
    await settle();
    await tick('15:21');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
  });

  it('第一次写库失败：放回去，下一分钟写成功（代码审查一 L10）', async () => {
    const real = await freshCache();
    let writes = 0;
    cache = { tx: (async (...a: Parameters<Cache['tx']>) => {
      if (a[1] === 'readwrite' && ++writes === 1) throw new Error('quota');
      return real.tx(...a);
    }) as unknown as () => Promise<never> };
    data.events = [timed()];
    nowMs = at('15:00');
    render(<RemindHost route="todos" since={at('15:00')} />);
    await settle();
    await tick('15:16');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
    expect(writes).toBe(1);
    const { readSeen } = await import('../data/remind-seen.ts');
    expect(await readSeen(real)).toEqual({});
    await tick('15:17');
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(await readSeen(real)).toEqual({ [`event:${E1}:${at('15:15')}`]: { tag: `event:${E1}:${at('15:15')}`, dueAt: at('15:15'), local: true } });
  });

  it('本机弹过、按了“知道了”（撤回）又撤销：60 分钟内不再弹第二次（代码审查一 L12）', async () => {
    data.events = [timed()];
    nowMs = at('15:00');
    render(<RemindHost route="todos" since={at('15:00')} />);
    await settle();
    await tick('15:16');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
    data.events = [{ ...timed(), notified_for: at('15:15') }];
    await tick('15:17');
    data.events = [timed()];
    await tick('15:18');
    await tick('15:19');
    expect(showLocalReminder).toHaveBeenCalledTimes(1);
  });
});
