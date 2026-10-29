// 离线队列测试共用的样例数据（不是测试文件本身）
import { openCache, type Cache } from '../cache.ts';
import { createOutbox, type Outbox, type OutboxItem } from '../outbox.ts';
import { fakeIndexedDB } from './idb-fake.ts';

export const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** todos 的一整行可写列（insert 用，去掉只能 update 的 deleted_at、undone） */
export function todo(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(n), title: `待办${n}`, done: false, due: null, important: false, project: '', note: '', source: 'page', raw_text: '',
    batch_id: null, from_note_id: null, from_anniv_id: null, short: null, short_by: null, done_at: 0, remind_days: null,
    remind_time: '09:00', due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null,
    created_at: 1, updated_at: 1, ...over,
  };
}

/** 造一个队列项（纯函数测试用） */
export const mk = (o: Partial<OutboxItem> & { seq: number; table?: string; id?: string }): OutboxItem => {
  const table = o.table ?? 'todos';
  const id = o.id ?? 'x';
  return {
    op_id: `op${o.seq}`, rec: `${table}:${id}`, op: 'patch', data: {}, base_rev: 1, own_revs: [], client_ts: 0, tries: 0, next_at: 0,
    state: 'pending', v: 1, app: '4.0.0', remind: false, deps: [], error: null, ...o, table, id,
  };
};

/** 测试时钟（各测试在 beforeEach 里复位） */
export const clock = { t: 1_000_000 };
let opSeq = 0;

/** 新库 + 新队列（已 boot） */
export async function setup(appVersion = '4.0.0'): Promise<{ cache: Cache; outbox: Outbox }> {
  const { factory } = fakeIndexedDB();
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  const outbox = createOutbox(r.cache, { appVersion, now: () => clock.t, newOpId: () => `op-${++opSeq}` });
  await outbox.boot();
  return { cache: r.cache, outbox };
}

/** 服务器上已有的一行（server = view） */
export async function seed(cache: Cache, table: string, id: string, data: Record<string, unknown>, rev = 5): Promise<void> {
  const s = { ...data, id, rev };
  await cache.putRows(table, [{ id, server: s, view: s }]);
}
