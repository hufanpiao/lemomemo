// 把几条记录归进某个分类（负责人 11-19：隐私记“里面的记录可以拖进分类里面，也可以在分类里倒入没分类的记录”；问“导入怎么选”答“勾选多条”）。
// • 照编辑页改分类的写法（note-edit.ts patchOf）：category_id、category_source = 'manual'、category_seen、updated_at
// • 经数据来源的写入口子（EditIo）逐条写：普通随手记进 outbox；隐私记由来源重新加密发 save
// • 回写成了几条、没写成几条；运行日志 notes category into n= ok= fail=（不记标题、分类名）
// 纯 TS，不准 React（A1）
import type { SaveOutcome } from '../../../core/edit-save.ts';
import { rlog } from '../../../platform/run-log-api.ts';

export interface NotePatchIo {
  patch(table: string, id: string, data: Record<string, unknown>, remind: boolean): Promise<SaveOutcome>;
}

export async function moveIntoCategory(io: NotePatchIo, ids: readonly string[], categoryId: string, now: () => number = Date.now): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  for (const id of ids) {
    const r = await io.patch('notes', id, { category_id: categoryId, category_source: 'manual', category_seen: true, updated_at: now() }, false);
    if (r === 'saved') ok++;
  }
  const failed = ids.length - ok;
  rlog(`notes category into n=${ids.length} ok=${ok} fail=${failed}`);
  return { ok, failed };
}
