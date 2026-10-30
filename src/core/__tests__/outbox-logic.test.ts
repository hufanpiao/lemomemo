// 离线队列的纯函数（架构 4.2、0.27 第 1 点、第七轮 S1）：失败归类、退避、rebase、发送顺序、确认后推进、入队校验
import { describe, expect, it } from 'vitest';
import {
  advanceAfterAck,
  backoffMs,
  classifyFailure,
  MAX_BACKOFF_MS,
  rebaseView,
  sendOrder,
  validateWrite,
} from '../outbox.ts';
import { isTryLater, tryLaterBackoffMs } from '../outbox-logic.ts';
import { mk, todo, uid } from './outbox-fixtures.ts';

describe('纯函数', () => {
  it('TC-B1-110（归类一半）：失败归类：426 不算永久失败；401 刷新；断网、5xx、429 退避；vault_required 丢掉；其他 4xx 永久', () => {
    expect(classifyFailure({ status: 426, min: '4.1.0' })).toBe('upgrade');
    expect(classifyFailure({ status: 400, code: 'upgrade_required' })).toBe('upgrade');
    expect(classifyFailure({ status: 401 })).toBe('auth');
    expect(classifyFailure({ status: 400, code: 'jwt_expired' })).toBe('auth');
    expect(classifyFailure({ network: true })).toBe('transient');
    expect(classifyFailure({ status: 503 })).toBe('transient');
    expect(classifyFailure({ status: 429 })).toBe('transient');
    expect(classifyFailure({ status: 400, code: 'vault_required' })).toBe('drop');
    expect(classifyFailure({ status: 409, code: 'settings_key_immutable' })).toBe('drop');
    expect(classifyFailure({ status: 400 })).toBe('permanent');
    expect(classifyFailure({ status: 403 })).toBe('permanent');
    expect(classifyFailure({ code: 'validation' })).toBe('permanent');
  });

  it('退避 2、4、8 秒……最长 5 分钟', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it('rebase：server 上按 seq 叠加 pending、inflight，跳过 failed', () => {
    const server = { id: 'x', title: 'A', note: 'n', rev: 3 };
    const v = rebaseView(server, [
      mk({ seq: 2, data: { note: 'm' } }),
      mk({ seq: 1, data: { title: 'B' }, state: 'inflight' }),
      mk({ seq: 3, data: { title: 'C' }, state: 'failed' }),
    ]);
    expect(v).toEqual({ id: 'x', title: 'B', note: 'm', rev: 3 });
    expect(rebaseView(null, [mk({ seq: 1, op: 'insert', data: { id: 'x', title: 'new' } })])).toEqual({ id: 'x', title: 'new' });
    expect(rebaseView(null, [mk({ seq: 1, data: { title: 'x' } })])).toBeNull();
  });

  it('发送顺序：带提醒的整条记录提前；同一条记录不颠倒；有依赖的不跑到被依赖前面', () => {
    const items = [
      mk({ seq: 1, id: 'a' }),
      mk({ seq: 2, id: 'n', table: 'notes' }),
      mk({ seq: 3, id: 'b', op: 'insert' }),
      mk({ seq: 4, id: 'b', remind: true, deps: [{ table: 'notes', id: 'n' }] }),
      mk({ seq: 5, id: 'a' }),
    ];
    expect(sendOrder(items, 0).map((i) => i.seq)).toEqual([2, 3, 4, 1, 5]);
  });

  it('发送顺序：记录最早一项在退避中，整条都等；依赖在退避中，本条也等；v 不对的不发', () => {
    const items = [
      mk({ seq: 1, id: 'a', next_at: 100 }),
      mk({ seq: 2, id: 'a' }),
      mk({ seq: 3, id: 'b', deps: [{ table: 'todos', id: 'a' }], remind: true }),
      mk({ seq: 4, id: 'c', v: 2 }),
      mk({ seq: 5, id: 'd', state: 'inflight' }),
      mk({ seq: 6, id: 'd' }),
      mk({ seq: 7, id: 'e' }),
    ];
    expect(sendOrder(items, 50).map((i) => i.seq)).toEqual([7]);
    expect(sendOrder(items, 100).map((i) => i.seq)).toEqual([1, 2, 3, 7]);   // b 带提醒，但依赖 a，所以 a 先
  });

  it('确认后推进（S1）：prev_rev = base_rev 时改 base_rev、清 own_revs；否则把 rev 记进 own_revs；超过 20 个清空', () => {
    const sent = mk({ seq: 1, base_rev: 5 });
    const later = [mk({ seq: 2, base_rev: 5 }), mk({ seq: 3, base_rev: 5, own_revs: [7] })];
    expect(advanceAfterAck(later, sent, { status: 'ok', rev: 6, prev_rev: 5 }).map((i) => [i.base_rev, i.own_revs])).toEqual([
      [6, []],
      [6, []],
    ]);
    expect(advanceAfterAck(later, sent, { status: 'ok', rev: 9, prev_rev: 8 }).map((i) => [i.base_rev, i.own_revs])).toEqual([
      [5, [9]],
      [5, [7, 9]],
    ]);
    const full = mk({ seq: 2, own_revs: Array.from({ length: 20 }, (_, k) => k) });
    expect(advanceAfterAck([full], sent, { status: 'ok', rev: 99, prev_rev: 98 })[0]?.own_revs).toEqual([]);
    const ins = mk({ seq: 1, op: 'insert', base_rev: null });
    expect(advanceAfterAck([mk({ seq: 2, base_rev: null })], ins, { status: 'ok', rev: 1, prev_rev: null })[0]?.base_rev).toBe(1);
  });

  it('校验：rows.ts 有严格版的按它校验；其余按清单的可写列；不同步的表拒收', () => {
    expect(validateWrite({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) })).toBeNull();
    expect(validateWrite({ table: 'todos', id: uid(1), op: 'insert', data: { ...todo(1), rev: 3 } })).toBe('invalid_row');
    expect(validateWrite({ table: 'todos', id: uid(2), op: 'insert', data: todo(1) })).toBe('id_mismatch');
    expect(validateWrite({ table: 'todos', id: uid(1), op: 'patch', data: { id: uid(1) } })).toBe('invalid_row');
    expect(validateWrite({ table: 'todos', id: uid(1), op: 'patch', data: { undone: true } })).toBeNull();
    expect(validateWrite({ table: 'categories', id: 'c', op: 'patch', data: { pushed_for: 1 } })).toBe('column_not_writable:pushed_for');
    expect(validateWrite({ table: 'logs', id: 'l', op: 'insert', data: { id: 'l' } })).toBe('table_not_synced');
  });
});

// TC-B1-90（架构 0.29 续第 110 条①、续第 119 条②）：客户端收到 try_later 只退避重试。
// 服务器回的形状：Edge Function 的 requireActiveUser 在 session_alive 出错或超时时回 503 {error: 'try_later'}
// （supabase/tests/offline/auth-check.mjs 第 46、47 行，错误体是 shared/schema/api.ts 的 apiError）；
// 走 PostgREST 时，PL/pgSQL 的 raise exception 'try_later' 是 HTTP 400，sync-transport.ts 的 toFailure 从 message 取出 code: 'try_later'。
// 两种形状都按 code 认，不看状态码，免得 400 落进“其他 4xx 永久失败”。现在 apply_patch 不调 session_alive，这一支是按架构预先守住的
describe('TC-B1-90：try_later 只退避重试', () => {
  it('不管 503 还是 400，try_later 都算临时故障（不进“其他 4xx”的 permanent，也不是 removed）', () => {
    expect(classifyFailure({ status: 503, code: 'try_later' })).toBe('transient');
    expect(classifyFailure({ status: 400, code: 'try_later' })).toBe('transient');
    expect(isTryLater({ status: 503, code: 'try_later' })).toBe(true);
    expect(isTryLater({ status: 400, code: 'try_later' })).toBe(true);
  });

  it('退避按连续 try_later 的次数：5 秒、30 秒、2 分钟，之后每 5 分钟', () => {
    expect([1, 2, 3, 4, 5, 50].map(tryLaterBackoffMs)).toEqual([5_000, 30_000, 120_000, 300_000, 300_000, 300_000]);
    // 0 或负数按第一次算，不会是 0 秒（防止无限快速重试）
    expect(tryLaterBackoffMs(0)).toBe(5_000);
  });

  it('对照：别的 503、5xx、429、断网照旧（不是 try_later，退避 2、4、8 秒……最长 5 分钟）', () => {
    for (const f of [{ status: 503 }, { status: 503, code: 'db_unreachable' }, { status: 500 }, { status: 429 }, { network: true }]) {
      expect(classifyFailure(f)).toBe('transient');
      expect(isTryLater(f)).toBe(false);
    }
    expect([1, 2, 3, 9].map(backoffMs)).toEqual([2000, 4000, 8000, MAX_BACKOFF_MS]);
    // 其他 4xx 照旧永久失败
    expect(classifyFailure({ status: 400, code: 'something_else' })).toBe('permanent');
  });
});
