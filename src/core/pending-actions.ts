// SW 记下的通知按键（架构 4.1、0.29 续第 107 条）：页面启动时丢掉别的账号的和超过 24 小时的，其余转进 outbox
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache } from './cache.ts';
import { PENDING_ACTIONS } from './cache-schema.ts';
import { OutboxRejectError } from './outbox-logic.ts';
import type { EnqueueInput, Outbox, PendingAction } from './outbox-types.ts';

/** 超过 24 小时的通知按键丢掉 */
export const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
/** created_at 比“现在”晚这么多以上的也丢掉（时钟被拨回过；代码审查 S5、安全审查 FE-S2：不然 now - created_at 为负，永远不过期） */
export const PENDING_ACTION_FUTURE_MS = 5 * 60 * 1000;
/** 推迟分钟数的范围（和 SW 的 src/sw/push.ts 一致：1 分钟～1 天） */
const SNOOZE_MAX_MIN = 24 * 60;
const PENDING_TABLES: ReadonlySet<string> = new Set(['events', 'todos', 'anniversaries']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SW 写的那一种按键（src/sw/pending.ts 的 SnoozeAction）：推迟多少分钟、按的是哪一次到点 */
export interface PendingSnooze {
  readonly type: 'snooze';
  readonly minutes: number;
  readonly due_at: number;
}

/**
 * SW 写的“完成”（src/sw/pending.ts 的 DoneAction；R-294、R-307）：只待办，和推迟同一条路径，转 outbox 后整页提醒里能撤销。
 * TODO(FA-4) 接 toEnqueue 时：due_at 必须对上这一行**当前这一次**到点的时刻，对不上（已经推迟过、改了时间、已完成）就丢弃，并钉测试（安全复审）
 */
export interface PendingDone {
  readonly type: 'done';
  readonly due_at: number;
}

/** 形状合格、能交给 toEnqueue 的一项 */
export type ValidPendingAction = PendingAction & { row_table: 'events' | 'todos' | 'anniversaries'; action: PendingSnooze | PendingDone };

/**
 * 形状对不对（按 SW 写入的规则再校验一遍；代码审查 S5、安全审查 FE-S3）：id、user_id 是非空字符串，row_table 是三张表之一，
 * row_id 是 UUID，action 是 { type: 'snooze', minutes: 1～1440 的整数, due_at: 正的安全整数 }，
 * 或 { type: 'done', due_at: 正的安全整数 }（只认 todos 表），created_at 是有限的数
 */
export function isValidPendingAction(a: unknown): a is ValidPendingAction {
  if (typeof a !== 'object' || a === null) return false;
  const o = a as Record<string, unknown>;
  const act = o['action'];
  if (typeof act !== 'object' || act === null) return false;
  const { type, minutes, due_at: dueAt } = act as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' && o['id'] !== '' &&
    typeof o['user_id'] === 'string' && o['user_id'] !== '' &&
    typeof o['row_table'] === 'string' && PENDING_TABLES.has(o['row_table']) &&
    typeof o['row_id'] === 'string' && UUID_RE.test(o['row_id']) &&
    typeof o['created_at'] === 'number' && Number.isFinite(o['created_at']) &&
    ((type === 'snooze' && typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= SNOOZE_MAX_MIN) ||
      (type === 'done' && o['row_table'] === 'todos')) &&
    typeof dueAt === 'number' && Number.isSafeInteger(dueAt) && dueAt > 0
  );
}

/** 留不留这一项：形状合格、本账号的、created_at 在 [now − 24 小时, now + 5 分钟] 里的才留 */
export function keepPendingAction(a: unknown, userId: string, now: number): a is ValidPendingAction {
  if (!isValidPendingAction(a) || a.user_id !== userId) return false;
  return a.created_at <= now + PENDING_ACTION_FUTURE_MS && now - a.created_at <= PENDING_ACTION_TTL_MS;
}

/**
 * 页面启动时先清一遍（0.29 续第 107 条②，B2）：user_id 和当前账号不一致的、超过 24 小时的、时间在将来的、形状不对的删掉，返回删了几条。
 * 账号不同的库在这之前已经被 ensureAccount 整库清空，这里兜的是 SW 写进来的别人的项（K-sw-seal ⑴ 之外的万一）和放久了的项。
 * 剩下的由提醒功能经 drainPendingActions 转进 outbox（FA-4 接）
 */
export async function prunePendingActions(cache: Cache, args: { userId: string; now: number }): Promise<number> {
  const all = await cache.tx([PENDING_ACTIONS], 'readonly', (t) => t.getAll<unknown>(PENDING_ACTIONS));
  const drop = all.flatMap((a) => {
    if (keepPendingAction(a, args.userId, args.now)) return [];
    const id = typeof a === 'object' && a !== null ? (a as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? [id] : [];
  });
  if (drop.length) {
    await cache.tx([PENDING_ACTIONS], 'readwrite', async (t) => {
      for (const id of drop) await t.delete(PENDING_ACTIONS, id);
    });
  }
  return drop.length;
}

/**
 * 把 pending_actions 转进 outbox：别的账号的、超过 24 小时的、时间在将来的、形状不对的丢掉，其余（已按 isValidPendingAction 校验过）
 * 经 toEnqueue 转成写入进 outbox。
 * toEnqueue 返回 null 表示这个按键不用写（例如那一条已经没了）。转完（或丢掉）就删。返回转进队列的条数
 */
export async function drainPendingActions(
  cache: Cache,
  outbox: Outbox,
  args: { userId: string; now: number; toEnqueue: (a: ValidPendingAction) => EnqueueInput | null },
): Promise<number> {
  const all = await cache.tx([PENDING_ACTIONS], 'readonly', (t) => t.getAll<PendingAction>(PENDING_ACTIONS));
  let n = 0;
  for (const a of all) {
    const input = keepPendingAction(a, args.userId, args.now) ? args.toEnqueue(a) : null;
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
