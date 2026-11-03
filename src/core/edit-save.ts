// 编辑页保存（B2 任务单 FA-2）：日程、待办编辑页共用的“写一次、把结果变成界面要的一个码”
// • 经 write.*（入队），不直接碰 outbox（架构 4.1）
// • 结果：saved；或没写进去的原因——local_unavailable / closing / switching（write.ts 文件头）、
//   readonly（这一行带不认识的值，只读，0.27①：界面出“这条要新版本才能修改 · 更新”）、rejected（校验不过：长度、格式）
// • 调用方义务（write.ts）：没写进去时界面提示“没保存上”并保留输入；switching 例外（页面马上跳走）
// 纯 TS：不准 import React 和任何功能（A1）
import { OutboxRejectError } from './outbox.ts';
import { write, type WriteFailReason } from './write.ts';

export type SaveOutcome = 'saved' | WriteFailReason | 'readonly' | 'rejected';

async function run(f: () => ReturnType<typeof write.insert>): Promise<SaveOutcome> {
  try {
    const r = await f();
    return r.ok ? 'saved' : r.reason;
  } catch (e) {
    if (e instanceof OutboxRejectError) return e.code === 'readonly_row' ? 'readonly' : 'rejected';
    throw e;
  }
}

/** 新建一行（整行可写列） */
export function saveInsert(table: string, row: Record<string, unknown> & { id: string }, remind: boolean): Promise<SaveOutcome> {
  return run(() => write.insert(table, row, { remind }));
}

/** 改一行（只放变了的列） */
export function savePatch(table: string, id: string, data: Record<string, unknown>, remind: boolean): Promise<SaveOutcome> {
  return run(() => write.patch(table, id, data, { remind }));
}

/**
 * 删除（软删，进“最近删除”）；撤销删除把 deleted_at 改回 null。
 * remind：这一行删之前或恢复以后会不会响（代码审查补审改法 ④：删了要尽快上服务器撤掉提醒，恢复要尽快重算）
 */
export function saveDeleted(table: string, id: string, deleted: boolean, now: number, remind = false): Promise<SaveOutcome> {
  return run(() => write.patch(table, id, { deleted_at: deleted ? now : null, updated_at: now }, { remind }));
}
