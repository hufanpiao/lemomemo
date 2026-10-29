// SW 记下的通知按键（架构 4.1、0.29 续第 107 条）：页面启动时丢掉别的账号的和超过 24 小时的，其余转进 outbox
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache } from './cache.ts';
import { PENDING_ACTIONS } from './cache-schema.ts';
import { OutboxRejectError } from './outbox-logic.ts';
import type { EnqueueInput, Outbox, PendingAction } from './outbox-types.ts';

/** 超过 24 小时的通知按键丢掉 */
export const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 页面启动时处理 pending_actions：别的账号的、超过 24 小时的丢掉，其余经 toEnqueue 转成写入进 outbox。
 * toEnqueue 返回 null 表示这个按键不用写（例如那一条已经没了）。返回转进队列的条数
 */
export async function drainPendingActions(
  cache: Cache,
  outbox: Outbox,
  args: { userId: string; now: number; toEnqueue: (a: PendingAction) => EnqueueInput | null },
): Promise<number> {
  const all = await cache.tx([PENDING_ACTIONS], 'readonly', (t) => t.getAll<PendingAction>(PENDING_ACTIONS));
  let n = 0;
  for (const a of all) {
    const keep = a.user_id === args.userId && args.now - a.created_at <= PENDING_ACTION_TTL_MS;
    const input = keep ? args.toEnqueue(a) : null;
    if (input) {
      try {
        await outbox.enqueue(input);
        n++;
      } catch (e) {
        if (!(e instanceof OutboxRejectError)) throw e;
      }
    }
    await cache.tx([PENDING_ACTIONS], 'readwrite', (t) => t.delete(PENDING_ACTIONS, a.id));
  }
  return n;
}
