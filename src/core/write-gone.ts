// gone 卡的两个按钮（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.2、4.3）：write.* 一族的入口，功能层只经这里，不直接碰 outbox（架构 4.1，M2）
// • 单独成文件、不放进 write.ts：write.ts 在首屏块里，冲突提示整套放在首屏之后（首屏只剩 0.3 KB 余量）。只有 sync-notice 按需加载时用它
// • restore = “恢复并保留我的修改”，drop = “不用了”；返回值的界面处理见方案 4.2
// • 失败的映射同 write.patch（write.ts 文件头）：没启动、本机库打不开、严格校验代码下载不下来 → local_unavailable；库正在关 → closing；
//   换账号、被移除、设了闸 → switching；真正的拒收（undone、readonly_row、row_missing、严格校验的码）→ rejected，带 code
// • 恢复后带不带提醒（M7）：恢复就是把删掉的行放回来，按恢复后的整行用 shared 的 remindAtOf 现算（规则同各编辑页：core/remind-flag.ts），
//   算得出、且不早于 now − 2 分钟，或者服务器上的 remind_at、snooze_at 还会响，就带上；只有待办、日程有提醒
// 纯 TS：不准 import React 和任何功能（A1）
import { ALL_DAY_LIVE_UNTIL, remindAtOf } from '../../shared/logic/remind.ts';
import type { Tz } from '../../shared/core/tz.ts';
import { getBoot } from './boot.ts';
import { CacheClosedError } from './cache.ts';
import { currentTz } from './current-tz.ts';
import { resolveGoneImpl } from './outbox-gone.ts';
import { OutboxCodeUnavailableError, OutboxRejectError } from './outbox-logic.ts';
import { outboxCtx } from './outbox.ts';
import { remindLive, rowRemindPending, todoRemindAfter, todoRemindFields } from './remind-flag.ts';
import { localWriteBlocker, type WriteFailReason } from './write.ts';

export type ResolveGoneResult =
  /** opId：恢复项的 op_id（只有 restored 有；冲突提示按它认“刚恢复”的那一项） */
  | { ok: true; done: 'restored' | 'dropped' | 'nothing'; opId: string | null }
  | { ok: false; reason: WriteFailReason | 'rejected'; code?: string };

type RowLike = Readonly<Record<string, unknown>>;

/** 待办里改了这些列，remindAtOf 的 prevRemindAt 就不传（同 todos/data/todo-edit.ts 的 TODO_TIMING_COLS；功能之间不互相 import，这里各写一份） */
const TODO_TIMING_COLS: readonly string[] = ['due', 'due_time', 'remind_before_min'];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * 恢复以后这一行带不带提醒。row 是本机 view 叠上恢复 patch 的整行（deleted_at 已是 null），patch 是恢复 patch 本身；
 * tz 是 current_tz（全天日程、待办的浮动时刻用），now 是本机时间
 */
export function restoredRemind(table: string, row: RowLike, patch: RowLike, tz: Tz, now: number): boolean {
  if (rowRemindPending(row, now)) return true;   // 服务器上的 remind_at、snooze_at 还会响（按过“稍后”时按字段算不出来）
  if (table === 'todos') {
    const prev = TODO_TIMING_COLS.some((c) => c in patch) ? undefined : num(row['remind_at']);
    return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, prev);
  }
  if (table === 'events') {
    const date = str(row['date']);
    if (date === null) return false;
    const at = remindAtOf(
      'event',
      { date, time: str(row['time']), tz: str(row['tz']), remind_min: num(row['remind_min']), remind_days: num(row['remind_days']), deleted_at: null },
      tz,
      now,
      undefined,
      ALL_DAY_LIVE_UNTIL,
    );
    return remindLive(at, now);
  }
  return false;
}

/** 处理一条记录的 gone 项：restore 恢复并保留本机的修改，drop 放弃本机的修改（行留在“最近删除”） */
export async function resolveGone(table: string, id: string, mode: 'restore' | 'drop'): Promise<ResolveGoneResult> {
  const blocker = localWriteBlocker();
  const outbox = getBoot()?.outbox;
  const ctx = outbox ? outboxCtx.get(outbox) : undefined;
  if (blocker || !ctx) return { ok: false, reason: blocker ?? 'local_unavailable' };
  const tz = currentTz();
  try {
    const r = await resolveGoneImpl(ctx, table, id, mode, {
      remindOf: (merged, patch) => restoredRemind(table, merged, patch, tz, Date.now()),
    });
    return { ok: true, done: r.done, opId: r.opId };
  } catch (e) {
    if (e instanceof CacheClosedError) return { ok: false, reason: localWriteBlocker() === 'switching' ? 'switching' : 'closing' };
    if (e instanceof OutboxRejectError) return e.code === 'outbox_suspended' ? { ok: false, reason: 'switching' } : { ok: false, reason: 'rejected', code: e.code };
    if (e instanceof OutboxCodeUnavailableError) return { ok: false, reason: 'local_unavailable' };
    throw e;
  }
}
