// 通知上按的“推迟 / 完成”转进 outbox（架构 0.29 续第 102 条③、第 107 条；R-294、R-307；第三方审查：SW 写进 pending_actions 以后全仓没人转，按了等于没按）
// • SW（src/sw/push.ts）只记“哪条、按了哪个键、按的是哪一次到点（due_at）”；这里按这一行**现在**的提醒核对，再转成和页面内按的同一套写法：
//   推迟 = snoozeWrite（remind-write.ts，页面“稍后”同一份），snooze_at 从按键那一刻（created_at）起算；完成 = core/todo-done.ts 的 todoDonePatch
//   （列表、今天页、整页提醒打勾同一份，提醒标记按 remind-flag 算）
// • 丢弃（core/pending-drain.ts 记运行日志）：gone 这一行本机没有了、已删、已完成；stale due_at 对不上现在这一次（推迟过、改了时间）或这一次已处理
// • later：纪念日的推算还没加载好（本机不知道这一行），留着下次再转
// • 取、删、入队、同事务、闸都在 core/pending-drain.ts 的 drainPendingActions；什么时候转见 hooks/usePendingDrain.ts
import type { Tz } from '../../../../shared/core/tz.ts';
import { getBoot } from '../../../core/boot.ts';
import type { ValidPendingAction } from '../../../core/outbox.ts';
import { drainPendingActions, type PendingVerdict } from '../../../core/pending-drain.ts';
import { todoDonePatch } from '../../../core/todo-done.ts';
import { canWriteLocal } from '../../../core/write.ts';
import type { Reminder } from './reminder-model.ts';
import { snoozeWrite } from './remind-write.ts';

const KIND_OF = { events: 'event', todos: 'todo', anniversaries: 'anniv' } as const;

/** 按类型、行 id 找这一行现在的提醒：不是提醒了返回 undefined；现在还判断不了返回 'later' */
export type FindReminder = (kind: Reminder['kind'], id: string) => Reminder | undefined | 'later';

/** 一个通知按键 → 写什么（或丢掉、留着） */
export function pendingVerdict(a: ValidPendingAction, find: FindReminder, now: number, tz: Tz): PendingVerdict {
  const r = find(KIND_OF[a.row_table], a.row_id);
  if (r === 'later') return 'later';
  if (!r) return { drop: 'gone' };
  if (r.handled || r.tagDue !== a.action.due_at) return { drop: 'stale' };
  if (a.action.type === 'done') {
    const w = todoDonePatch(r.row, true, now, tz);
    return { table: 'todos', id: r.id, op: 'patch', data: w.data, remind: w.remind };
  }
  const w = snoozeWrite(r, a.created_at + a.action.minutes * 60_000, now);
  return { table: w.table, id: w.id, op: 'patch', data: w.data, remind: w.remind };
}

/** 转一遍本机库里的通知按键；没启动、本机写不进（换账号途中等）时不动，留着下次。返回转进队列的条数 */
export async function drainNotifyActions(find: FindReminder, now: number, tz: Tz): Promise<number> {
  const boot = getBoot();
  if (!boot?.cache || !boot.outbox || !boot.userId || !canWriteLocal()) return 0;
  return drainPendingActions(boot.cache, boot.outbox, { userId: boot.userId, now, toEnqueue: (a) => pendingVerdict(a, find, now, tz) });
}
