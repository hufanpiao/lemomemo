// 发送循环在发请求前记下本机会话的 session_id，被移除、停用时随事件带回（接手清单 K6-sugg4 ①）：
// 回包前别的标签页把本机会话换成了 s2，带回的仍是发请求时的 s1——app/sync-wiring.ts 据此只删 s1
// （从 send.test.ts 拆出来，那边已近 300 行）
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../../store.ts';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import type { OutboxEvent } from '../../outbox-types.ts';
import { sendAll, type SendDeps } from '../send.ts';
import { fakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

async function run(prepare: (t: ReturnType<typeof fakeTransport>) => void) {
  const { outbox } = await setup();
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
  const t = fakeTransport();
  t.sid = 's1';
  prepare(t);
  const events: OutboxEvent[] = [];
  outbox.onEvent((e) => events.push(e));
  const removed: [string, string | null][] = [];
  const d: SendDeps = {
    outbox, transport: t, gated: () => outbox.isSuspended(), blocked: () => false, emit: () => undefined,
    removed: (code, sid) => removed.push([code, sid]), touched: () => undefined,
  };
  const out = await sendAll(d);
  return { out, events, removed };
}

describe('被移除、停用带回发请求时的 sid（K6-sugg4 ①）', () => {
  for (const [code, type] of [['session_revoked', 'removed'], ['account_disabled', 'disabled']] as const) {
    it(`insert 回 ${code}：回包前本机换成了 s2，outbox 的 ${type} 事件带的仍是 s1`, async () => {
      const r = await run((t) => {
        const insert = t.insertRow.bind(t);
        t.insertRow = async (table, data) => {
          t.sid = 's2';   // 请求在路上：别的标签页写进了新会话
          t.failNext.push({ status: 403, code });
          return insert(table, data);
        };
      });
      expect(r.events).toContainEqual({ type, code, sid: 's1' });
    });
  }

  it('K6-sugg5 ④(b)：传输层带回了真正发出去的会话（SendFailure.sid），优先用它；带回 null 也照用', async () => {
    for (const got of ['s9', null] as const) {
      const r = await run((t) => {
        t.failNext.push({ status: 403, code: 'session_revoked', sid: got });
      });
      expect(r.events).toContainEqual({ type: 'removed', code: 'session_revoked', sid: got });
    }
  });

  it('401 后刷新令牌回被移除：removed 带的是刷新前记下的 s1', async () => {
    const r = await run((t) => {
      t.failNext.push({ status: 401 });
      t.refreshSession = async () => {
        t.sid = 's2';
        return 'removed';
      };
    });
    expect(r.out).toBe('removed');
    expect(r.removed).toEqual([['session_not_found', 's1']]);
  });

  it('发送前看令牌就回被移除：removed 带的是看令牌之前记下的 s1', async () => {
    const r = await run((t) => {
      t.ensureSession = async () => {
        t.sid = 's2';
        return 'removed';
      };
    });
    expect(r.removed).toEqual([['session_not_found', 's1']]);
  });

  it('本机读不出会话（null）、实现抛错：带 null', async () => {
    const a = await run((t) => {
      t.sid = null;
      t.failNext.push({ status: 403, code: 'session_revoked' });
    });
    expect(a.events).toContainEqual({ type: 'removed', code: 'session_revoked', sid: null });
    const b = await run((t) => {
      t.sessionId = () => {
        throw new Error('denied');
      };
      t.failNext.push({ status: 403, code: 'session_revoked' });
    });
    expect(b.events).toContainEqual({ type: 'removed', code: 'session_revoked', sid: null });
  });
});
