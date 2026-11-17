// 待办优先级的就地切换（R-434）：待办页、今天页行右边的 H / M / L 换档（点哪格设哪档、键盘读屏换下一档，kit PrioCycle），两页都调这里，不各写一份。
// • 写的两列由 shared/logic/todo-row.ts 的 prioCols 给（priority + 旧列 important 双写，迁移 20261115100000 文件头）；编辑页按表单整份写（todo-edit.ts 的 patchOf，同样经 prioCols）
// • 优先级不影响提醒：remind 标记一律 false
// • 运行日志记一行“改成哪一档、结果”，不记标题
// 纯 TS：不准 import React 和任何功能（A1）
import { prioCols, type Priority } from '../../shared/logic/todo-row.ts';
import { rlog } from '../platform/run-log-api.ts';
import { savePatch, type SaveOutcome } from './edit-save.ts';

export async function setTodoPriority(id: string, p: Priority, now: number): Promise<SaveOutcome> {
  const res = await savePatch('todos', id, { ...prioCols(p), updated_at: now }, false);
  rlog(`todo prio set=${p} res=${res}`);
  return res;
}
