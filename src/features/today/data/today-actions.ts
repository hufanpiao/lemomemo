// “最近删除”页的写入：日程、待办、随手记的删除 / 撤销删除、从“最近删除”恢复；都经 core 的 edit-save（write.*），不碰 outbox
// • 今天页待办行的打勾、删除、换优先级不走这里：kit/hooks/useTodoWrites.ts（core/todo-done.ts、todo-writes.ts，三页同一份）
// • 待办删除的 remind 标记在 core/todo-writes.ts（这里 todos 那一支也调它，不另写）
// • 删除是软删（deleted_at = now，进“最近删除”）；撤销和恢复把 deleted_at 改回 null；都算 remind 标记
// • “最近删除”的列表在 trash.ts（不进首屏）；永久删除、全部清空在 trash-purge-api.ts
import type { Tz } from '../../../../shared/core/tz.ts';
import { saveDeleted, type SaveOutcome } from '../../../core/edit-save.ts';
import { eventRemindFields, eventRemindLive, eventRemindPendingBefore } from '../../../core/remind-flag.ts';
import { remindAfterDelete } from '../../../core/todo-writes.ts';
import type { Row } from './today-model.ts';

/** 能进“最近删除”的表（隐私记有自己的“最近删除”） */
export type TrashTable = 'events' | 'todos' | 'notes';

/** 删除 / 撤销删除、从“最近删除”恢复的 remind 标记（规则在 core/remind-flag.ts）：删前还会响，或者恢复后会响 */
export function remindOnDelete(table: TrashTable, row: Row, deleted: boolean, now: number, tz: Tz): boolean {
  if (table === 'notes') return false;   // 随手记没有提醒
  if (table === 'todos') return remindAfterDelete(row, deleted, now, tz);
  return deleted ? eventRemindPendingBefore(row, now, tz) : eventRemindLive(eventRemindFields(row, false), tz, now);
}

/** 删除（软删）/ 撤销删除、从“最近删除”恢复 */
export function setDeleted(table: TrashTable, row: Row, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return saveDeleted(table, row.id, deleted, now, remindOnDelete(table, row, deleted, now, tz));
}
