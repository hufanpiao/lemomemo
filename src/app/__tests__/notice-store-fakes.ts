// 冲突提示队列测试的假依赖（sync-notice-store.test.ts、sync-notice-store-restored.test.ts 共用）
import type { OutboxItem } from '../../core/outbox-types.ts';
import type { SyncEvent } from '../../core/sync/types.ts';
import type { ResolveGoneResult } from '../../core/write-gone.ts';
import { createNoticeStore, type NoticeStoreDeps } from '../sync-notice-store.ts';

let seq = 0;
export function item(table: string, id: string, data: Record<string, unknown>, over: Partial<OutboxItem> = {}): OutboxItem {
  seq += 1;
  return {
    op_id: `op-${seq}`, table, id, rec: `${table}:${id}`, op: 'patch', data, base_rev: 1, own_revs: [], client_ts: 0, tries: 0, next_at: 0,
    state: 'failed', v: 1, app: '4.0.0', seq, remind: false, deps: [], error: 'gone', ...over,
  };
}

export type Conflict = Extract<SyncEvent, { type: 'conflict' }>;
export const conflict = (over: Partial<Conflict> = {}): Conflict => ({
  type: 'conflict', status: 'conflict', table: 'todos', id: 't1', conflicts: ['note'], old: { note: '另一台' }, forkId: null, opId: 'op-x', ...over,
});

/** 一套假依赖：queue 就是 outbox.list() 的结果，calls 记下 resolveGone 的调用 */
export function make(over: Partial<NoticeStoreDeps> = {}) {
  const queue: OutboxItem[] = [];
  const calls: [string, string, string][] = [];
  const logs: [string, unknown][] = [];
  let next: ResolveGoneResult = { ok: true, done: 'dropped', opId: null };
  const deps: NoticeStoreDeps = {
    outbox: { list: async () => [...queue] },
    readRow: async (table, id) => ({ title: `行${table}:${id}`, name: `名${id}` }),
    resolveGone: async (table, id, mode) => {
      calls.push([table, id, mode]);
      return next;
    },
    log: (act, f) => logs.push([act, f]),
    forkSuffix: '（冲突副本）',
    ...over,
  };
  const store = createNoticeStore(deps);
  return { store, queue, calls, logs, reply: (r: ResolveGoneResult) => (next = r) };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((ok) => setTimeout(ok, 0));
};
