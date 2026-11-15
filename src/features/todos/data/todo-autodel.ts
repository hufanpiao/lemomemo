// 完成满 7 天的待办自动删除（负责人 11-15“完成 7 天后没有操作自动删除”，已选方案）：进“最近删除”（软删，30 天内能恢复），不是彻底删
// • 条件：没删、没撤销；done = true；done_at > 0 且 ≤ now − 7 天；完成以后没再动过——这条的 updated_at ≤ done_at，
//   它的子任务（todo_items，含已删的）updated_at 也都 ≤ done_at（完成后改过子任务也算动过）。只读行（core 的 readonlyIds）跳过
// • 什么时候扫：每次打开 App，同步引擎第一次整轮拉取成功以后扫一遍（app/main.tsx 经 wireSync 的 onFirstPull、功能入口 index.ts 的 loadTodoAutoDel 按需下载这一份；
//   审查 11-15 第 1 条：本机数据先跟上服务器，别的设备完成后改过的不会按旧的 updated_at 误删）；离线、拉取失败这次不扫，下次打开再扫
// • 怎么写：和列表上手动删除同一个函数（./todo-actions.ts 的 setTodoDeleted → core/edit-save 的 saveDeleted → write，进 outbox），所有设备跟着同步；服务器、数据库不改
// • 开关：settings 键 todo.autodel（默认开；设置页“完成 7 天后自动删除”，ui/TodoSettings.tsx）；值为 false 才不删
// • 运行日志每次扫都记一行，只记条数、不记标题：开关关着 todo autodel off；扫完 todo autodel scan=本机待办条数 due=该删几条 n=删成几条；
//   出错 todo autodel err=run（这里接住）、err=load（下载这一份失败，app/main.tsx 记）
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { numOr } from '../../../../shared/logic/todo-row.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { collection, readonlyIds } from '../../../core/store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { ITEMS_TABLE } from './todo-items.ts';
import { setTodoDeleted } from './todo-actions.ts';
import type { Row } from './todo-list.ts';

export const AUTODEL_KEY = 'todo.autodel';
export const AUTODEL_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** 开关开着没有：没设过、设成别的都算开，只有 false 是关 */
export function autoDelOn(settings: readonly SettingRow[]): boolean {
  return settingValue(settings, AUTODEL_KEY) !== false;
}

/** 该自动删的待办（纯函数）：todos、子任务、只读 id 都由调用方给 */
export function autoDelDue(todos: readonly Row[], items: readonly Row[], ro: ReadonlySet<string>, now: number): Row[] {
  // 每条待办的子任务最后一次改动
  const touched = new Map<string, number>();
  for (const i of items) {
    const id = i['todo_id'];
    if (typeof id === 'string') touched.set(id, Math.max(touched.get(id) ?? 0, numOr(i['updated_at'], 0)));
  }
  return todos.filter((r) => {
    const doneAt = numOr(r['done_at'], 0);
    return (
      isLiveRow(r) && r['done'] === true && doneAt > 0 && doneAt <= now - AUTODEL_AFTER_MS &&
      numOr(r['updated_at'], 0) <= doneAt && (touched.get(r.id) ?? 0) <= doneAt && !ro.has(r.id)
    );
  });
}

export interface AutoDelDeps {
  now(): number;
  tz(): Tz;
  remove(row: Row, now: number, tz: Tz): Promise<unknown>;
}

const defaults: AutoDelDeps = {
  now: () => clock.now(),
  tz: currentTz,
  remove: (row, now, tz) => setTodoDeleted(row, true, now, tz),
};

/** 扫本机集合一遍，返回删了几条（over：测试换时钟、时区、写入）（开关关着、出错是 0）；一条写失败不影响别的条，下次打开再扫；不抛错 */
export async function runTodoAutoDel(over: Partial<AutoDelDeps> = {}): Promise<number> {
  try {
    if (!autoDelOn(collection<SettingRow>('settings').getSnapshot())) {
      rlog('todo autodel off');
      return 0;
    }
    const deps = { ...defaults, ...over };
    const now = deps.now();
    const tz = deps.tz();
    const todos = collection<Row>('todos').getSnapshot();
    const due = autoDelDue(todos, collection<Row>(ITEMS_TABLE).getSnapshot(), readonlyIds('todos').getSnapshot(), now);
    const res = await Promise.allSettled(due.map((r) => deps.remove(r, now, tz)));
    const n = res.filter((x) => x.status === 'fulfilled' && x.value === 'saved').length;
    rlog(`todo autodel scan=${todos.length} due=${due.length} n=${n}`);
    return n;
  } catch {
    rlog('todo autodel err=run');
    return 0;
  }
}
