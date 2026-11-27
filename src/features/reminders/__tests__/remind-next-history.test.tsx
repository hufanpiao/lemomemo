// 整页提醒连看几条算同一层（R-372，负责人 11-10“往左滑应该是返回上一个层级，不是返回上一个操作”）：
// 点“下一条”原地换这条历史（不新压），左滑 / 浏览器后退一步就离开整页提醒，回到打开它之前那一页
// 替身和 RemindViews.test.tsx 同一套（本机集合、写入、时钟、键盘、桥接、路由）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]) => 'saved' as const);
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));
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
const openReminder = vi.fn(async (..._a: unknown[]) => undefined);
const showLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
const closeLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: (...a: unknown[]) => openReminder(...a),
  showLocalReminder: (...a: unknown[]) => showLocalReminder(...a),
  closeLocalReminder: (...a: unknown[]) => closeLocalReminder(...a),
  reminderHash: (kind: string, id: string, due: number) => `#/remind/${kind}/${id}?due=${due}`,
}));
const closeHandled = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: (...a: unknown[]) => closeHandled(...a) }));
const navigate = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../app/router.ts', () => ({
  canGoBack: () => false,
  goBack: vi.fn(),
  navigate: (...a: unknown[]) => navigate(...a),
  replaceRoute: (...a: unknown[]) => navigate(...a),
  backTo: (...a: unknown[]) => void navigate(...a),
}));
let remindRecs: ReadonlySet<string> = new Set();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }) } }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { default: FullReminderPage } = await import('../ui/FullReminderPage.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
const ev = (id: string, title: string, time: string, over: Record<string, unknown> = {}): Row => ({
  id, title, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null, ...over,
});
const tick = (hm: string): void => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev(E1, '和 Kim 开会', '15:30'), ev(E2, '牙医', '15:45')];
  data.todos = [];
  data.settings = [];
  nowMs = at('15:00');
  remindRecs = new Set();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  for (const f of [savePatch, openReminder, showLocalReminder, closeLocalReminder, closeHandled, navigate]) f.mockClear();
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/** 引擎读完本机“响过”记录、算好第一份快照才 armed（REMIND-shown-persist）：两步都是异步的，冲几拍 */
const armedNow = () =>
  act(async () => {
    for (let k = 0; k < 6; k++) await Promise.resolve();
  });



describe('整页提醒“下一条”不记步数（R-372）', () => {
  it('今天 → 打开整页提醒（压一条）→ 连看两条 → 后退一步回今天', async () => {
    window.history.replaceState(null, '', '#/today');
    const base = window.history.length;
    window.location.hash = `#/remind/event/${E1}?due=${at('15:15')}`; // 和 openReminder 一样：入口压一条
    expect(window.history.length).toBe(base + 1);
    render(<RemindHost route="remind" />);
    await armedNow();
    tick('15:31');
    render(<FullReminderPage />);
    const oldUrls: string[] = [];
    const onHash = (e: HashChangeEvent): void => void oldUrls.push(e.oldURL);
    window.addEventListener('hashchange', onHash);
    fireEvent.click(screen.getByTestId('remind-full-next'));
    window.removeEventListener('hashchange', onHash);
    expect(window.location.hash).toBe(`#/remind/event/${E2}?due=${at('15:30')}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('牙医'); // 本页跟着重画
    expect(oldUrls).toEqual([expect.stringContaining(`#/remind/event/${E1}`)]); // 路由收到地址变了（带 oldURL，照旧判动画）
    expect(window.history.length).toBe(base + 1); // 不新压
    expect(openReminder).not.toHaveBeenCalled();
    window.history.back();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
  });
});
