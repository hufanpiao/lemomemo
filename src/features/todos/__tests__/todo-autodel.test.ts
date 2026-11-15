// 完成满 7 天的待办自动删除（负责人 11-15 方案；data/todo-autodel.ts）：哪些删、哪些不删，写入走和手动删除同一条路（write → outbox）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection, readonlyIds } from '../../../core/store.ts';

const w = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../../core/write.ts', async (orig) => {
  const m = await orig<{ write: object }>();
  return { ...m, write: { ...m.write, patch: async (...a: unknown[]) => (w.calls.push(a), { ok: true }) } };
});
const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (m: string) => void logs.push(m) }));

const { AUTODEL_AFTER_MS, AUTODEL_KEY, runTodoAutoDel } = await import('../data/todo-autodel.ts');

const NOW = Date.UTC(2026, 10, 15, 3);
const DAY = 24 * 60 * 60 * 1000;
const deps = { now: () => NOW, tz: () => 'Asia/Seoul' };
const todo = (id: string, doneAgo: number | null, over: Record<string, unknown> = {}) => {
  const doneAt = doneAgo === null ? 0 : NOW - doneAgo;
  return { id, title: `标题${id}`, done: doneAgo !== null, done_at: doneAt, updated_at: doneAt || 1, deleted_at: null, undone: false, due: null, ...over };
};
/** 不换写入：走默认的 setTodoDeleted（和列表上手动删除同一个函数） */
const run = () => runTodoAutoDel(deps);
const deletedIds = () => w.calls.map((c) => c[1]);

beforeEach(() => {
  clearAllCollections();
  w.calls = [];
  logs.length = 0;
});
afterEach(() => clearAllCollections());

describe('完成 7 天后自动删除', () => {
  it('满 7 天删、6 天不删；没完成的不删；已删的不再删', async () => {
    collection('todos').upsert([
      todo('a', AUTODEL_AFTER_MS),
      todo('b', 8 * DAY),
      todo('c', 6 * DAY),
      todo('d', null),
      todo('e', 9 * DAY, { deleted_at: NOW - DAY }),
    ]);
    expect(await run()).toBe(2);
    expect(deletedIds().sort()).toEqual(['a', 'b']);
  });

  it('写入走和手动删除同一条路：write.patch(todos, id, { deleted_at, updated_at }) 进 outbox；运行日志只记条数、不记标题', async () => {
    collection('todos').upsert([todo('a', 8 * DAY)]);
    await run();
    expect(w.calls[0]?.slice(0, 3)).toEqual(['todos', 'a', { deleted_at: NOW, updated_at: NOW }]);
    expect(logs).toEqual(['todo autodel n=1']);
    expect(logs.join()).not.toContain('标题');
  });

  it('完成以后编辑过（updated_at 晚于 done_at）不删；改过子任务（含删掉的子任务）也不删；子任务没动过的照删', async () => {
    collection('todos').upsert([
      todo('edited', 8 * DAY, { updated_at: NOW - 3 * DAY }),
      todo('sub', 8 * DAY),
      todo('subdel', 8 * DAY),
      todo('subold', 8 * DAY),
    ]);
    collection('todo_items').upsert([
      { id: 'i1', todo_id: 'sub', updated_at: NOW - 2 * DAY, deleted_at: null },
      { id: 'i2', todo_id: 'subdel', updated_at: NOW - 2 * DAY, deleted_at: NOW - 2 * DAY },
      { id: 'i3', todo_id: 'subold', updated_at: NOW - 8 * DAY, deleted_at: null },
    ]);
    await run();
    expect(deletedIds()).toEqual(['subold']);
  });

  it('开关关掉（todo.autodel = false）不删；设成别的、被删掉的那一行都按默认开', async () => {
    collection('todos').upsert([todo('a', 8 * DAY)]);
    collection('settings').upsert([{ id: 's1', key: AUTODEL_KEY, value: false, deleted_at: null }]);
    expect(await run()).toBe(0);
    expect(w.calls).toEqual([]);
    expect(logs).toEqual([]);
    collection('settings').upsert([{ id: 's1', key: AUTODEL_KEY, value: false, deleted_at: NOW }]);
    expect(await run()).toBe(1);
  });

  it('只读行跳过', async () => {
    collection('todos').upsert([todo('ro', 8 * DAY), todo('ok', 8 * DAY)]);
    readonlyIds('todos').set([{ id: 'ro', ro: true }]);
    await run();
    expect(deletedIds()).toEqual(['ok']);
  });

  it('一条写失败不影响别的条，日志记失败条数', async () => {
    collection('todos').upsert([todo('a', 8 * DAY), todo('b', 8 * DAY)]);
    const n = await runTodoAutoDel({ ...deps, remove: async (r) => (r.id === 'a' ? Promise.reject(new Error('x')) : 'saved') });
    expect(n).toBe(1);
    expect(logs).toEqual(['todo autodel n=1 failed=1']);
  });
});
