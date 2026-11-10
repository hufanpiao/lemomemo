// 待办编辑页 R-375（11-10 负责人“动了提醒就自动设截止为今天”）：没设截止时改了提醒，截止日期自动填今天；改成“不提醒”不填、已有截止不动；
// 自动填了以后提醒时刻已过出灰字。搭建同 TodoEditPage.test.tsx（真实冷启动、假 IndexedDB，时钟固定首尔 2026-11-05 09:00）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { deviceTz } from '../../../core/current-tz.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { clock } from '../../../platform/clock.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import TodoEditPage from '../ui/TodoEditPage.tsx';

const ID = '00000000-0000-4000-8000-0000000000a1';
const NOW = msAt('2026-11-05', 9 * 60, 'Asia/Seoul');
type Row = { id: string } & Record<string, unknown>;
const todos = () => collection<Row>('todos');

async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  // “今天”按 current_tz 算（R-375 M2）：固定成首尔，和时钟同一个时区；不设时回落本机时区，CI 的洛杉矶那一组会算成 11-04
  b.profile = { ...(b.profile ?? {}), current_tz: 'Asia/Seoul' } as NonNullable<typeof b.profile>;
  return b;
}

const serverTodo = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: ID, title: '交报告', done: false, due: '2026-11-05', important: false, project: '', note: '', source: 'voice', raw_text: '今天五点前交报告',
    batch_id: null, from_note_id: null, from_anniv_id: null, short: '交报', short_by: 'ai', done_at: 0, remind_days: 0, remind_time: '09:00',
    due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null, deleted_at: null, undone: false,
    created_at: 1, updated_at: 1, rev: 3, ...over,
  }) as ServerRow;

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<TodoEditPage />);
}

async function commitText(testId: string, value: string) {
  const el = screen.getByTestId(testId);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

async function pick(testId: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
  });
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('R-375：没设截止时改了提醒，截止日期自动填今天', () => {
  it('新建：写了标题、没设截止，把提醒改成“前一天”→ 截止日期填今天（11-05），灰字换成“已经过了”；可以再改截止日期', async () => {
    await boot();
    open('#/todo/new');
    expect(screen.getByText('设了提醒，截止日期会自动填今天')).toBeTruthy();
    await commitText('todo-edit-title', '交材料');
    await waitFor(() => expect(todos().getSnapshot()).toHaveLength(1));
    await pick('todo-edit-days', '1');
    await waitFor(() => expect(todos().getSnapshot()[0]).toMatchObject({ due: '2026-11-05', remind_days: 1 }));
    expect((screen.getByTestId('todo-edit-due') as HTMLInputElement).value).toBe('2026-11-05');
    expect(screen.getByText('这个提醒时刻已经过了，不会再提醒')).toBeTruthy();
    await commitText('todo-edit-due', '2026-11-08');
    await waitFor(() => expect(todos().getSnapshot()[0]?.['due']).toBe('2026-11-08'));
    expect(screen.queryByText('这个提醒时刻已经过了，不会再提醒')).toBeNull();
  });

  it('编辑：没截止的待办改提醒时刻 → 截止填今天、写入带 remind；时刻没过不出灰字', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due: null }) }]);
    open(`#/todo/${ID}`);
    await commitText('todo-edit-remind-time', '18:00');
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ due: '2026-11-05', remind_time: '18:00', remind_days: 0 }));
    const items = (await b.outbox?.list()) ?? [];
    expect(items.at(-1)).toMatchObject({ op: 'patch', remind: true, data: { due: '2026-11-05', remind_time: '18:00' } });
    expect(screen.queryByText('这个提醒时刻已经过了，不会再提醒')).toBeNull();
    expect(screen.queryByText('设了提醒，截止日期会自动填今天')).toBeNull();
  });

  it('改成“不提醒”不填截止；已有截止的改提醒不动截止', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due: null }) }]);
    open(`#/todo/${ID}`);
    await pick('todo-edit-days', 'null');
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ remind_days: null, due: null }));
    cleanup();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due: '2026-11-20', rev: 9 }) }]);
    open(`#/todo/${ID}`);
    await pick('todo-edit-days', '1');
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ remind_days: 1, due: '2026-11-20' }));
  });

  it('“今天”按 current_tz（和灰字同口径）：current_tz 首尔、本机洛杉矶，首尔 11-05 09:00（洛杉矶还是 11-04）→ 填 11-05', async () => {
    const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...orig.call(this), timeZone: 'America/Los_Angeles' };
    });
    expect(deviceTz()).toBe('America/Los_Angeles');
    const b = await boot(); // boot() 已把 current_tz 设成首尔
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due: null }) }]);
    open(`#/todo/${ID}`);
    await commitText('todo-edit-remind-time', '18:00');
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ due: '2026-11-05', remind_time: '18:00' }));
    expect(screen.queryByText('这个提醒时刻已经过了，不会再提醒')).toBeNull();
  });

  it('韩文灰字', async () => {
    await boot();
    uiStore.getState().setLocale('ko-KR');
    open('#/todo/new');
    expect(screen.getByText('알림을 정하면 마감일이 오늘로 정해져요')).toBeTruthy();
  });
});
