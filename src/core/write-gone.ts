// gone 卡（冲突提示）的两个按钮：write.* 一族的入口，功能层只经这里，不直接碰 outbox
// • 单独成文件、不放进 write.ts：write.ts 在首屏块里，冲突提示整套放在首屏之后。只有 sync-notice 按需加载时用它
// • restore = “恢复并保留我的修改”，drop = “不用了”
// • 失败的映射同 write.patch（write.ts 文件头）：没启动、本机库打不开、严格校验代码下载不下来 → local_unavailable；库正在关 → closing；
//   换账号、被移除、设了闸 → switching；真正的拒收（undone、readonly_row、row_missing、严格校验的码）→ rejected，带 code
// • 恢复后带不带提醒：按恢复后的整行现算（规则同各编辑页，都在 core/remind-flag.ts），
//   算得出、且不早于 now − 2 分钟，或者服务器上的 remind_at、snooze_at 还会响，就带上。待办、日程、纪念日有提醒；
//   纪念日的推算库在 resolveGone 里先加载，加载不了只看服务器上的 remind_at、snooze_at
// 纯 TS：不准 import React 和任何功能
import type { Tz } from '../../shared/core/tz.ts';
import { ANNIV_LIB } from './anniv-lib.ts';
import { getBoot } from './boot.ts';
import { currentTz } from './current-tz.ts';
import { resolveGoneImpl } from './outbox-gone.ts';
import { OutboxRejectError } from './outbox-logic.ts';
import { outboxCtx } from './outbox.ts';
import { annivRemindLive, eventRemindPendingBefore, rowRemindPending, todoPrevRemindAt, todoRemindAfter, todoRemindFields } from './remind-flag.ts';
import { localWriteBlocker, writeFailOf, type WriteFailReason } from './write.ts';

export type ResolveGoneResult =
  /** opId：恢复项的 op_id（只有 restored 有；冲突提示按它认“刚恢复”的那一项） */
  | { ok: true; done: 'restored' | 'dropped' | 'nothing'; opId: string | null }
  | { ok: false; reason: WriteFailReason | 'rejected'; code?: string };

type RowLike = Readonly<Record<string, unknown>>;

/**
 * 恢复以后这一行带不带提醒。row 是本机 view 叠上恢复 patch 的整行（deleted_at 已是 null），patch 是恢复 patch 本身；
 * tz 是 current_tz（全天日程、待办的浮动时刻用），now 是本机时间。纪念日要推算库已加载（resolveGone 先加载），没加载只看服务器上的
 */
export function restoredRemind(table: string, row: RowLike, patch: RowLike, tz: Tz, now: number): boolean {
  if (rowRemindPending(row, now)) return true;   // 服务器上的 remind_at、snooze_at 还会响（按过“稍后”时按字段算不出来）
  if (table === 'todos') return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, todoPrevRemindAt(row, patch));
  if (table === 'events') return eventRemindPendingBefore(row, now, tz);
  if (table === 'anniversaries' && ANNIV_LIB.ready()) {
    const lib = ANNIV_LIB.get();
    return annivRemindLive(lib, lib.annivRecOf(row), tz, now);
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
  // 纪念日恢复要现算提醒（见文件头）：先加载推算库；加载失败 anniv-lib 自己记日志，这里照常恢复，只是不按字段算
  if (table === 'anniversaries' && mode === 'restore') await ANNIV_LIB.load().catch(() => undefined);
  try {
    const r = await resolveGoneImpl(ctx, table, id, mode, {
      remindOf: (merged, patch) => restoredRemind(table, merged, patch, tz, Date.now()),
    });
    return { ok: true, done: r.done, opId: r.opId };
  } catch (e) {
    const reason = writeFailOf(e);
    if (reason) return { ok: false, reason };
    if (e instanceof OutboxRejectError) return { ok: false, reason: 'rejected', code: e.code };
    throw e;
  }
}
