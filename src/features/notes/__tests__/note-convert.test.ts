// 随手记转成待办 / 日程的数据层（B4 S8，TC-B4-08 数据层部分）：先建新条、再给原条写 converted_to 和 deleted_at（deps 指新条），
// 失败撤回新条、撤不回的报出来；守门的几种拒绝一笔不写；真 outbox 上验队列、依赖抵消和“最近删除”的列入条件
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { convertNote, type ConvertDeps } from '../data/note-convert.ts';
import { boot, NOW, sendNext, serverNote, setupImageTests, uid, type Row } from './note-images-kit.tsx';

const TZ = 'Asia/Seoul';
const NEW = uid(900);
const OK: WriteResult = { ok: true, item: null };
const note = (over: Record<string, unknown> = {}): Row => ({
  id: uid(1), title: '买牛奶', body: '低脂的\n两盒', is_private: false, deleted_at: null, undone: false, converted_to: null, ...over,
});

type Call = { op: 'insert' | 'patch'; table: string; id: string; data: Record<string, unknown>; opts: unknown };
/** 桩写入口：按调用顺序给结果（函数可以抛错）；没给的一律 ok */
function stub(results: ((c: Call) => WriteResult)[] = []) {
  const calls: Call[] = [];
  const next = (c: Call): Promise<WriteResult> => {
    calls.push(c);
    const f = results[calls.length - 1];
    return Promise.resolve(f ? f(c) : OK);
  };
  const w: NonNullable<ConvertDeps['w']> = {
    insert: (table, data, opts) => next({ op: 'insert', table, id: data.id, data, opts }),
    patch: (table, id, data, opts) => next({ op: 'patch', table, id, data, opts }),
  };
  return { calls, deps: { w, newId: () => NEW, isReadonly: () => false } satisfies ConvertDeps };
}
const fail = (reason: 'local_unavailable' | 'closing' | 'switching') => (): WriteResult => ({ ok: false, reason });
const throws = (code: string) => (): WriteResult => {
  throw new OutboxRejectError(code);
};

describe('convertNote：桩写入口', () => {
  it('TC-B4-08 待办：先 insert(todos, 行)，再 patch(notes, 原条, {converted_to, deleted_at, updated_at})，deps 指新条；insert 不带 deps、不带 remind', async () => {
    const s = stub();
    const r = await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps);
    expect(r).toEqual({ ok: true, table: 'todos', id: NEW });
    expect(s.calls.map((c) => [c.op, c.table, c.id])).toEqual([['insert', 'todos', NEW], ['patch', 'notes', uid(1)]]);
    expect(s.calls[0]?.data['title']).toBe('买牛奶');
    expect(s.calls[0]?.data['from_note_id']).toBe(uid(1));
    expect(s.calls[0]?.opts).toEqual({});
    expect(s.calls[1]?.data).toEqual({ converted_to: [{ kind: 'todo', id: NEW }], deleted_at: NOW, updated_at: NOW });
    expect(s.calls[1]?.opts).toEqual({ deps: [{ table: 'todos', id: NEW }] });
  });

  it('TC-B4-08 日程：UTC 还在前一天、首尔已是第二天 → date 是首尔那天；converted_to 的 kind 是 event', async () => {
    const now = msAt('2026-11-11', 8 * 60, TZ);
    expect(new Date(now).toISOString().slice(0, 10)).toBe('2026-11-10');
    const s = stub();
    const r = await convertNote(note(), 'event', { now, tz: TZ }, s.deps);
    expect(r.ok).toBe(true);
    expect(s.calls[0]?.table).toBe('events');
    expect(s.calls[0]?.data['date']).toBe('2026-11-11');
    expect(s.calls[0]?.data['from_note_id']).toBeUndefined();
    expect(s.calls[1]?.data['converted_to']).toEqual([{ kind: 'event', id: NEW }]);
  });

  it('没有标题：新条标题是正文第一个非空行；一行时备注是空串，多行时备注是第二行起', async () => {
    const one = stub();
    await convertNote(note({ title: null, body: '买牛奶' }), 'todo', { now: NOW, tz: TZ }, one.deps);
    expect([one.calls[0]?.data['title'], one.calls[0]?.data['note']]).toEqual(['买牛奶', '']);
    const many = stub();
    await convertNote(note({ title: '', body: '\n买菜\n鸡蛋\n猫砂' }), 'todo', { now: NOW, tz: TZ }, many.deps);
    expect([many.calls[0]?.data['title'], many.calls[0]?.data['note']]).toEqual(['买菜', '鸡蛋\n猫砂']);
  });

  it('备注放不下（超过 2000 字）→ too_long，一笔不写；刚好 2000 字照常转', async () => {
    const s = stub();
    expect(await convertNote(note({ body: '长'.repeat(2001) }), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'too_long' });
    expect(s.calls).toHaveLength(0);
    expect((await convertNote(note({ body: '长'.repeat(2000) }), 'todo', { now: NOW, tz: TZ }, s.deps)).ok).toBe(true);
  });

  it('同一条正在转时再转 → busy、不多写一笔，运行日志只记结果码；转完放开，再转照常；别的条不受影响', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = stub();
    const slow: ConvertDeps = { ...s.deps, w: { ...s.deps.w, insert: async (...a) => (await gate, s.deps.w.insert(...a)) } };
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const first = convertNote(note(), 'todo', { now: NOW, tz: TZ }, slow);
    expect(await convertNote(note(), 'event', { now: NOW, tz: TZ }, slow)).toEqual({ ok: false, reason: 'busy' });
    expect((await convertNote(note({ id: uid(2) }), 'todo', { now: NOW, tz: TZ }, s.deps)).ok).toBe(true);
    release();
    expect((await first).ok).toBe(true);
    expect(s.calls.filter((c) => c.op === 'insert')).toHaveLength(2);
    expect((await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).ok).toBe(true);
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    expect(lines[0]).toBe('note convert event busy title=3 body=6');
    expect(lines.join(' ')).not.toContain('买牛奶');
  });

  it('写入抛了别的错（不是 OutboxRejectError）→ 照样往外抛，锁放开', async () => {
    const s = stub([() => {
      throw new Error('boom');
    }]);
    await expect(convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).rejects.toThrow('boom');
    expect((await convertNote(note(), 'todo', { now: NOW, tz: TZ }, stub().deps)).ok).toBe(true);
  });

  it('保留原条（keepNote）：只写 converted_to 和 updated_at，不写 deleted_at', async () => {
    const s = stub();
    await convertNote(note(), 'todo', { now: NOW, tz: TZ, keepNote: true }, s.deps);
    expect(s.calls[1]?.data).toEqual({ converted_to: [{ kind: 'todo', id: NEW }], updated_at: NOW });
  });

  it('标题和正文都空 → empty，一笔不写', async () => {
    const s = stub();
    expect(await convertNote(note({ title: null, body: ' \n ' }), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'empty' });
    expect(s.calls).toHaveLength(0);
  });

  it('已删、已撤销 → gone；隐私记 → rejected；只读行 → readonly；都一笔不写', async () => {
    const cases: [Row, string, boolean][] = [
      [note({ deleted_at: 5 }), 'gone', false],
      [note({ undone: true }), 'gone', false],
      [note({ is_private: true }), 'rejected', false],
      [note(), 'readonly', true],
    ];
    for (const [n, reason, ro] of cases) {
      const s = stub();
      const r = await convertNote(n, 'todo', { now: NOW, tz: TZ }, { ...s.deps, isReadonly: (id) => ro && id === uid(1) });
      expect(r).toEqual({ ok: false, reason });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('原条 converted_to 是认不出的形状 → rejected，一笔不写', async () => {
    const s = stub();
    expect(await convertNote(note({ converted_to: { kind: 'todo' } }), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'rejected' });
    expect(s.calls).toHaveLength(0);
  });

  it('原条 converted_to 已有一项（恢复后再转）→ 写进去两项，旧的在前', async () => {
    const s = stub();
    const old = { kind: 'event', id: uid(77) };
    await convertNote(note({ converted_to: [old] }), 'todo', { now: NOW, tz: TZ }, s.deps);
    expect(s.calls[1]?.data['converted_to']).toEqual([old, { kind: 'todo', id: NEW }]);
  });

  it('insert 没写进去（local_unavailable）→ 原因原样返回，随手记没被 patch', async () => {
    const s = stub([fail('local_unavailable')]);
    expect(await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'local_unavailable' });
    expect(s.calls).toHaveLength(1);
  });

  it('insert 抛 OutboxRejectError(invalid_row) → rejected，随手记没被 patch', async () => {
    const s = stub([throws('invalid_row')]);
    expect(await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'rejected' });
    expect(s.calls).toHaveLength(1);
  });

  // 撤销（架构 3.4 H10）= 写 deleted_at 和 undone = true：软删，30 天清理按 deleted_at 删掉、不长期占行数额度
  it('随手记那笔没写进去（closing）→ 撤回新条 {deleted_at, undone: true, updated_at}，返回 closing', async () => {
    const s = stub([() => OK, fail('closing')]);
    expect(await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'closing' });
    expect(s.calls.map((c) => [c.op, c.table, c.id])).toEqual([['insert', 'todos', NEW], ['patch', 'notes', uid(1)], ['patch', 'todos', NEW]]);
    expect(s.calls[2]?.data).toEqual({ deleted_at: NOW, undone: true, updated_at: NOW });
  });

  it('转日程时随手记那笔抛 readonly_row（入队时才发现只读）→ 撤回打在 events 的新条上，返回 readonly', async () => {
    const s = stub([() => OK, throws('readonly_row')]);
    expect(await convertNote(note(), 'event', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'readonly' });
    expect([s.calls[2]?.op, s.calls[2]?.table, s.calls[2]?.id]).toEqual(['patch', 'events', NEW]);
    expect(s.calls[2]?.data).toEqual({ deleted_at: NOW, undone: true, updated_at: NOW });
  });

  it('撤回也没写进去 → 返回原因并带上没撤掉的新条（left），调用方据此提示、不让用户再点出第二条', async () => {
    const s = stub([() => OK, fail('closing'), fail('closing')]);
    expect(await convertNote(note(), 'todo', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'closing', left: { table: 'todos', id: NEW } });
  });

  it('转日程、撤回也没写进去 → left 指 events 的新条', async () => {
    const s = stub([() => OK, fail('closing'), fail('closing')]);
    expect(await convertNote(note(), 'event', { now: NOW, tz: TZ }, s.deps)).toEqual({ ok: false, reason: 'closing', left: { table: 'events', id: NEW } });
    expect([s.calls[2]?.table, s.calls[2]?.id]).toEqual(['events', NEW]);
  });
});

describe('convertNote：真 outbox（假 IndexedDB 冷启动）', () => {
  setupImageTests();

  async function seeded() {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    const row = collection<Row>('notes').get(uid(1));
    if (!row) throw new Error('no_note');
    return { b, row };
  }

  it('TC-B4-08：todos 里出现新条；原条 deleted_at 不为空、undone 不是 true（“最近删除”的列入条件）、converted_to 指新条；队列两项，新条那项不依赖原条', async () => {
    const { b, row } = await seeded();
    const spy = vi.spyOn(crypto, 'randomUUID');
    const r = await convertNote(row, 'todo', { now: NOW, tz: TZ });   // 走默认 newId（crypto.randomUUID 脱离 this 调用会抛错）
    expect(spy).toHaveBeenCalled();
    if (!r.ok) throw new Error(r.reason);
    const todo = collection<Row>('todos').get(r.id);
    expect(todo?.['title']).toBe('第1条');
    expect(todo?.['from_note_id']).toBe(uid(1));
    const n = collection<Row>('notes').get(uid(1));
    expect(n?.['deleted_at']).toBe(NOW);
    expect(n?.['undone']).not.toBe(true);
    expect(n?.['converted_to']).toEqual([{ kind: 'todo', id: r.id }]);
    const q = (await b.outbox?.list()) ?? [];
    expect(q.map((i) => [i.op, i.table])).toEqual([['insert', 'todos'], ['patch', 'notes']]);
    expect(q[0]?.deps).toEqual([]);
    expect(q[1]?.deps).toEqual([{ table: 'todos', id: r.id }]);
  });

  it('新条的 insert 被撤销抵消 → 随手记那一笔一起抵消，原条回到没删、converted_to 为 null', async () => {
    const { b, row } = await seeded();
    const r = await convertNote(row, 'event', { now: NOW, tz: TZ });
    if (!r.ok) throw new Error(r.reason);
    const { write } = await import('../../../core/write.ts');
    await write.patch('events', r.id, { undone: true, updated_at: NOW + 1 });
    expect(await b.outbox?.list()).toEqual([]);
    const n = collection<Row>('notes').get(uid(1));
    expect(n?.['deleted_at']).toBeNull();
    expect(n?.['converted_to']).toBeNull();
  });

  it('两笔都发出去后，原条被永久删除（墓碑删本机行）→ 新条不受影响（TC-B4-08 第三条的数据层；服务器 purge 由 e2e 验）', async () => {
    const { b, row } = await seeded();
    const r = await convertNote(row, 'todo', { now: NOW, tz: TZ });
    if (!r.ok) throw new Error(r.reason);
    await sendNext();
    await sendNext();
    await b.outbox?.dropServer('notes', [uid(1)]);
    expect(collection<Row>('notes').get(uid(1))).toBeUndefined();
    expect(collection<Row>('todos').get(r.id)?.['title']).toBe('第1条');
  });
});
