// 把 SW 记下的通知按键转进 outbox（架构 0.29 续第 102 条③、第 107 条；第三方审查：原来全仓没人调，按了等于没按）
// • 由提醒功能调（features/reminders/hooks/usePendingDrain.ts）：要按这一行**现在**的提醒核对 due_at，
//   核对和“转成什么写入”在功能里（和页面内按“推迟 / 完成”同一套 patch），这里只管取、删、入队、记日志
// • 入队和删掉这一项在同一个事务里（Outbox.enqueue 的 also）：中间崩了要么都成、要么都没成，不会下次再入队一遍；
//   事务里先看这一项还在不在，两处同时转（回到前台和打开整页提醒一起触发、两个标签页）只有一处入得了队
// • 队列设了闸（outbox_suspended）、本机写不进（关库、代码没下载下来、存储满）：这一项留着，下次再试；真正的拒收（这一行本机没了等）才删
// • 丢掉的记一行运行日志：只有表名、按键、原因码，不记内容
// • 单独一个文件、不经 outbox.ts 转出：首屏（boot 的 prunePendingActions）用不到这些
// 纯 TS：不准 import React 和任何功能（A1）
import { rlog } from '../platform/run-log-api.ts';
import type { Cache } from './cache.ts';
import { PENDING_ACTIONS } from './cache-schema.ts';
import { OutboxRejectError } from './outbox-logic.ts';
import type { EnqueueInput, Outbox } from './outbox-types.ts';
import { keepPendingAction, PENDING_TABLES, type ValidPendingAction } from './pending-actions.ts';

/** 丢掉的原因码（运行日志用）：gone 这一行本机没有了、不再提醒；stale 提醒已经换过一次（推迟过、改了时间）或已处理 */
export type PendingDropReason = 'gone' | 'stale';

/** toEnqueue 的判断：写什么；丢掉（原因码）；later 现在还判断不了（纪念日推算还没加载等），留着下次再转 */
export type PendingVerdict = EnqueueInput | { readonly drop: PendingDropReason } | 'later';

/** 事务里发现这一项已经被别处转走了 */
class AlreadyTaken extends Error {}

const tableOf = (a: unknown): string => {
  const t = typeof a === 'object' && a !== null ? (a as { row_table?: unknown }).row_table : undefined;
  return typeof t === 'string' && PENDING_TABLES.has(t) ? t : '?';
};
const actionOf = (a: unknown): string => {
  const act = typeof a === 'object' && a !== null ? (a as { action?: unknown }).action : undefined;
  const t = typeof act === 'object' && act !== null ? (act as { type?: unknown }).type : undefined;
  return t === 'snooze' || t === 'done' ? t : '?';
};
const logDrop = (a: unknown, reason: string): void => rlog(`pending drop table=${tableOf(a)} action=${actionOf(a)} reason=${reason}`);

/**
 * 把 pending_actions 转进 outbox（见文件头）：别的账号的、超过 24 小时的、时间在将来的、形状不对的丢掉（reason=invalid），
 * 其余按 created_at 先后交给 toEnqueue 判断。同一行这一轮已经转过一项的，后面的留到下一轮（toEnqueue 看的是转之前的行）。
 * 返回转进队列的条数；本机写不进（关库等，不是拒收）时照抛，这一项留着
 */
export async function drainPendingActions(
  cache: Cache,
  outbox: Outbox,
  args: { userId: string; now: number; toEnqueue: (a: ValidPendingAction) => PendingVerdict },
): Promise<number> {
  const all = await cache.tx([PENDING_ACTIONS], 'readonly', (t) => t.getAll<unknown>(PENDING_ACTIONS));
  const valid: ValidPendingAction[] = [];
  const drop: unknown[] = [];
  for (const a of all) (keepPendingAction(a, args.userId, args.now) ? valid : drop).push(a);
  for (const a of drop) {
    const id = (a as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') continue;
    await cache.tx([PENDING_ACTIONS], 'readwrite', (t) => t.delete(PENDING_ACTIONS, id));
    logDrop(a, 'invalid');
  }
  valid.sort((x, y) => x.created_at - y.created_at);
  const rows = new Set<string>();
  let n = 0;
  for (const a of valid) {
    const rec = `${a.row_table}:${a.row_id}`;
    if (rows.has(rec)) continue;
    const v = args.toEnqueue(a);
    if (v === 'later') continue;
    if ('drop' in v) {
      await cache.tx([PENDING_ACTIONS], 'readwrite', (t) => t.delete(PENDING_ACTIONS, a.id));
      logDrop(a, v.drop);
      continue;
    }
    try {
      await outbox.enqueue(v, {
        stores: [PENDING_ACTIONS],
        run: async (t) => {
          if ((await t.get(PENDING_ACTIONS, a.id)) === undefined) throw new AlreadyTaken();
          await t.delete(PENDING_ACTIONS, a.id);
        },
      });
      rows.add(rec);
      n++;
    } catch (e) {
      if (e instanceof AlreadyTaken) continue;
      if (!(e instanceof OutboxRejectError)) throw e;
      if (e.code === 'outbox_suspended') return n;   // 换账号、被移除途中：留着，这一轮停下
      await cache.tx([PENDING_ACTIONS], 'readwrite', (t) => t.delete(PENDING_ACTIONS, a.id));
      logDrop(a, e.code);
    }
  }
  return n;
}
