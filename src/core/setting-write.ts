// settings 一行一键的读写（FA-4 代码审查 L7、接手清单 REMIND-settings-core）：提醒（reminders 的 data/remind-settings.ts）和
// 日历（calendar 的 data/cal-settings.ts）原来各写一遍，合到这里，和 setting-patch.ts 放在一起。纯 TS，不准 React（A1）
// • 读：本机 settings 集合里这个键“活着”的那一行（没软删、没撤销）的 value；没有就是 undefined
// • 算写什么（settingWrite）：有这一行就 patch（内容由 setting-patch.ts 的 settingPatch 给，被软删、撤销过的顺带恢复），没有就 insert；
//   值一样不写（对象值按 JSON 比）
// • 写（createSettingWriter）：经 core/write（进 outbox、本机先生效）；同一页里的写一条接一条排队；
//   本机集合里还没出现刚 insert 的那一行时，按记下的 id patch、不再 insert 第二次（不然撞 (user_id, key) 唯一约束、进“发送失败”，代码审查 L6）。
//   React 那一层（各功能的 useSettingWriter / useCalSettings）只管取本机集合和 error 状态
import { settingPatch } from './setting-patch.ts';
import { write } from './write.ts';

import { live, type SettingRow } from './setting-read.ts';

export { settingValue, type SettingRow } from './setting-read.ts';

export type SettingWrite =
  | { readonly op: 'insert'; readonly data: { readonly key: string; readonly value: unknown } }
  | { readonly op: 'patch'; readonly id: string; readonly data: Readonly<Record<string, unknown>> };

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 把 key 改成 value 要写什么；已经是这个值时 null（不写） */
export function settingWrite(rows: readonly SettingRow[], key: string, value: unknown): SettingWrite | null {
  const row = rows.find((r) => r.key === key && live(r)) ?? rows.find((r) => r.key === key);
  if (!row) return { op: 'insert', data: { key, value } };
  if (live(row) && typeof value === 'object' && value !== null && sameJson(row.value, value)) return null;
  const data = settingPatch(row, value);
  return data ? { op: 'patch', id: row.id, data } : null;
}

export interface SettingWriterDeps {
  /** 最新的本机 settings 行（排队中的写读它，不读旧的那份） */
  rows(): readonly SettingRow[];
  /** 新行的 id */
  newId(): string;
  /** 每次真写了以后：写进本机没有 */
  onResult(ok: boolean): void;
}

export interface SettingWriter {
  /** 排队写一个键；值一样不写 */
  save(key: string, value: unknown): Promise<void>;
}

/** 一页一个：排队、记下本页 insert 过的行（key → id 和写进去的值的 JSON） */
export function createSettingWriter(deps: SettingWriterDeps): SettingWriter {
  const inserted = new Map<string, { id: string; json: string }>();
  let queue: Promise<void> = Promise.resolve();

  const saveNow = async (key: string, value: unknown): Promise<void> => {
    const cur = deps.rows();
    const mine = inserted.get(key);
    const json = JSON.stringify(value);
    // 刚 insert 的那一行还没进本机集合：按记下的 id 改，值一样就不写
    if (mine && !cur.some((r) => r.key === key)) {
      if (mine.json === json) return;
      const r = await write.patch('settings', mine.id, { value });
      if (r.ok) inserted.set(key, { id: mine.id, json });
      deps.onResult(r.ok);
      return;
    }
    const w = settingWrite(cur, key, value);
    if (!w) return;
    if (w.op === 'insert') {
      const id = deps.newId();
      const r = await write.insert('settings', { id, ...w.data });
      if (r.ok) inserted.set(key, { id, json });
      deps.onResult(r.ok);
      return;
    }
    const r = await write.patch('settings', w.id, w.data);
    deps.onResult(r.ok);
  };

  return {
    save(key, value) {
      const next = queue.then(() => saveNow(key, value));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
