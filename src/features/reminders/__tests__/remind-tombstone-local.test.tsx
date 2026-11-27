// TC-B2-77（B2 QA 缺口 G-06）：Y 端收到墓碑、本机删掉 T 以后，本机通知跟着取消——到点不弹，已经弹出的撤回；另一条 U 照常
// 原来只有 remind-data.test.ts 的 shouldCloseShown（本机没有这一行时回 false，是“打开 App 关系统通知”那条路），没有测引擎这一侧。
// 墓碑怎么删本机行由 src/core/sync/__tests__/pull.test.ts 测（tombstones 增量拉、本机有这一行才删）；这里接着它往下：
// 本机集合里 T 这一行没了（useCollection 不再给出它）以后，exe 的每分钟检查（useRemindEngine）
//   ① T 还没到点：到点时不调 showLocalReminder（不响），U 照常弹；
//   ② T 已经弹出过：下一次检查调 closeLocalReminder 撤回 T 那条，U 那条不撤；
//   ③ 墓碑到达时 T 正在 App 里响（横幅）：横幅里的 T 也消失。
// 场景按用例：Y 没来得及拉到 X 上的软删除（离线），直接收到永久删除的墓碑，所以 Y 本机的 T 还是一条正常、会响的待办。
// 替身和 RemindEngine.test.tsx 同一套（照搬，去掉这里用不到的日程样例和 outbox 补写工具）。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
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
}));
const closeHandled = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: (...a: unknown[]) => closeHandled(...a) }));
const navigate = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: (...a: unknown[]) => navigate(...a) }));
let remindRecs: ReadonlySet<string> = new Set();
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
const outboxSubs = new Set<() => void>();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    outbox: {
      subscribe: (fn: () => void) => {
        outboxSubs.add(fn);
        return () => outboxSubs.delete(fn);
      },
      getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }),
      list: async () => outboxList,
    },
  }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const tick = (hm: string): void => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [];
  data.todos = [];
  data.settings = [];
  nowMs = at('15:00');
  remindRecs = new Set();
  outboxList = [];
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

const T = '00000000-0000-4000-8000-0000000000a1';
const U = '00000000-0000-4000-8000-0000000000a2';
/** 有截止时刻、提前 0 分钟提醒的待办（remind_at 已经同步回来） */
const todo = (id: string, title: string, hm: string): Row => ({
  id, title, due: DAY, due_time: hm, remind_before_min: 0, remind_days: null, remind_time: '09:00',
  done: false, deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null,
  source: 'app', push_show_title: null, remind_at: at(hm),
});
const tagOf = (id: string, hm: string): string => `todo:${id}:${at(hm)}`;
/** 墓碑到达：本机集合里删掉这一行（pull.ts 对本机有的行做的事） */
const tombstone = (id: string): void => {
  data.todos = (data.todos ?? []).filter((r) => r.id !== id);
};
const shownTags = (): string[] => showLocalReminder.mock.calls.map((c) => (c[0] as { tag: string }).tag);

describe('TC-B2-77：收到墓碑后取消本机通知', () => {
  it('① T 还没到点就收到墓碑：到点不弹 T，U 照常弹', async () => {
    data.todos = [todo(T, '交房租', '15:10'), todo(U, '取快递', '15:12')];
    render(<RemindHost route="todos" />);
    await armedNow();
    tick('15:02');
    expect(showLocalReminder).not.toHaveBeenCalled();
    tombstone(T);
    tick('15:10');
    tick('15:12');
    tick('15:13');
    expect(shownTags()).toEqual([tagOf(U, '15:12')]);
  });

  it('② T 已经弹出：收到墓碑后撤回 T 那条，U 那条不撤', async () => {
    data.todos = [todo(T, '交房租', '15:10'), todo(U, '取快递', '15:10')];
    render(<RemindHost route="todos" />);
    await armedNow();
    tick('15:10');
    expect(shownTags().sort()).toEqual([tagOf(T, '15:10'), tagOf(U, '15:10')].sort());
    expect(closeLocalReminder).not.toHaveBeenCalled();
    tombstone(T);
    tick('15:11');
    expect(closeLocalReminder.mock.calls.map((c) => c[0])).toEqual([tagOf(T, '15:10')]);
    // 之后不会再弹 T
    tick('15:12');
    expect(shownTags().filter((t) => t === tagOf(T, '15:10'))).toHaveLength(1);
  });

  it('③ T 正在 App 里响（横幅）时收到墓碑：横幅里的 T 消失', async () => {
    data.todos = [todo(T, '交房租', '15:10')];
    render(<RemindHost route="todos" />);
    await armedNow();
    tick('15:10');
    await screen.findByText(/交房租/);
    tombstone(T);
    tick('15:11');
    await waitFor(() => expect(screen.queryByText(/交房租/)).toBeNull());
  });
});
