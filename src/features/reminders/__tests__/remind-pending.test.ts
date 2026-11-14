// 通知上按的“推迟 / 完成”转进 outbox（data/remind-pending.ts 的 pendingVerdict；架构 0.29 续第 102 条③、第 107 条；第三方审查：原来全仓没人转）
// • 和页面内按“稍后 / 完成”同一套写法：snoozeWrite（remind-write.ts）、todoDonePatch（core/todo-done.ts）
// • due_at 要对上这一行**现在**这一次到点（tagDue），已经换过一次的、已处理的丢（stale）；行没了、不再提醒的丢（gone）；纪念日推算没加载好的留着（later）
import { beforeEach, describe, expect, it } from 'vitest';
import { todoDonePatch } from '../../../core/todo-done.ts';
import type { ValidPendingAction } from '../../../core/outbox.ts';
import { drainPendingActions } from '../../../core/pending-drain.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { clock, seed, setup, todo, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { pendingVerdict, type FindReminder } from '../data/remind-pending.ts';
import { reminderOf, type Reminder } from '../data/reminder-model.ts';
import { snoozeWrite } from '../data/remind-write.ts';

const SEOUL = 'Asia/Seoul';
const NOW = 2_000_000_000_000;
const DUE = NOW - 60_000;
/** 一条正在响的待办（稍后到 DUE 的那一次；tagDue = DUE） */
const row = (over: Record<string, unknown> = {}) => ({ ...todo(1), deleted_at: null, undone: false, snooze_at: DUE, ...over });
const rem = (over: Record<string, unknown> = {}): Reminder => {
  const r = reminderOf('todo', row(over) as never, NOW, SEOUL);
  if (!r) throw new Error('no reminder');
  return r;
};
const pa = (action: ValidPendingAction['action'], over: Partial<ValidPendingAction> = {}): ValidPendingAction => ({
  id: 'p1',
  user_id: 'me',
  row_table: 'todos',
  row_id: uid(1),
  action,
  created_at: NOW - 30_000,
  ...over,
});
const findOf = (r: Reminder | undefined | 'later'): FindReminder => () => r;

describe('pendingVerdict：和页面内按“稍后 / 完成”同一套写法', () => {
  it('推迟：snooze_at = 按键时刻 + 分钟数，写法就是 snoozeWrite（带提醒标记）', () => {
    const r = rem();
    const v = pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }), findOf(r), NOW, SEOUL);
    const w = snoozeWrite(r, NOW - 30_000 + 10 * 60_000, NOW);
    expect(v).toEqual({ table: w.table, id: w.id, op: 'patch', data: w.data, remind: w.remind });
    expect(v).toMatchObject({ table: 'todos', data: { snooze_at: NOW - 30_000 + 600_000, updated_at: NOW }, remind: true });
  });

  it('完成：写法就是 todoDonePatch（done、done_at、提醒标记按 remind-flag 算）', () => {
    const r = rem();
    const w = todoDonePatch(r.row, true, NOW, SEOUL);
    expect(pendingVerdict(pa({ type: 'done', due_at: DUE }), findOf(r), NOW, SEOUL)).toEqual({ table: 'todos', id: uid(1), op: 'patch', data: w.data, remind: w.remind });
  });

  it('提醒已经换过一次（推迟过、改了时间）：stale，不写', () => {
    const r = rem({ snooze_at: DUE + 600_000 });
    expect(pendingVerdict(pa({ type: 'done', due_at: DUE }), findOf(r), NOW, SEOUL)).toEqual({ drop: 'stale' });
    expect(pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }), findOf(r), NOW, SEOUL)).toEqual({ drop: 'stale' });
  });

  it('这一次已经处理过（别处按了知道了）：stale', () => {
    const r = { ...rem(), handled: true };
    expect(pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }), findOf(r), NOW, SEOUL)).toEqual({ drop: 'stale' });
  });

  it('行已删、已完成（不再是提醒）：gone', () => {
    expect(pendingVerdict(pa({ type: 'done', due_at: DUE }), findOf(undefined), NOW, SEOUL)).toEqual({ drop: 'gone' });
  });

  it('还判断不了（纪念日推算没加载好）：later，留着', () => {
    expect(pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }, { row_table: 'anniversaries' }), findOf('later'), NOW, SEOUL)).toBe('later');
  });

  it('按表找对类型：events → event、anniversaries → anniv', () => {
    const asked: string[] = [];
    const find: FindReminder = (kind) => {
      asked.push(kind);
      return undefined;
    };
    pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }, { row_table: 'events' }), find, NOW, SEOUL);
    pendingVerdict(pa({ type: 'snooze', minutes: 10, due_at: DUE }, { row_table: 'anniversaries' }), find, NOW, SEOUL);
    expect(asked).toEqual(['event', 'anniv']);
  });
});

describe('接上 drainPendingActions：本机这一行跟着改（和页面内按的一样经 outbox 改 view）', () => {
  beforeEach(() => {
    clearAllCollections();
    clock.t = NOW;
  });

  it('通知上按“完成”：待办打勾、进队列、按键删掉', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), row());
    await cache.tx(['pending_actions'], 'readwrite', (t) => t.put('pending_actions', pa({ type: 'done', due_at: DUE })));
    const find: FindReminder = (kind, id) => {
      const x = collection<{ id: string } & Record<string, unknown>>('todos').get(id) ?? row();
      return kind === 'todo' ? (reminderOf('todo', x as never, NOW, SEOUL) ?? undefined) : undefined;
    };
    const n = await drainPendingActions(cache, outbox, { userId: 'me', now: NOW, toEnqueue: (a) => pendingVerdict(a, find, NOW, SEOUL) });
    expect(n).toBe(1);
    expect((await outbox.list())[0]).toMatchObject({ rec: `todos:${uid(1)}`, op: 'patch', data: { done: true, done_at: NOW } });
    expect((await cache.getRow('todos', uid(1)))?.view).toMatchObject({ done: true });
    expect(await cache.tx(['pending_actions'], 'readonly', (t) => t.getAll('pending_actions'))).toEqual([]);
  });
});
