// settings 一行一键的读写（FA-4 代码审查 L7、接手清单 REMIND-settings-core）：提醒（reminders 的 data/remind-settings.ts）和
// 日历（calendar 的 data/cal-settings.ts）原来各写一遍，合到这里，和 setting-patch.ts 放在一起。纯 TS，不准 React（A1）
// • 读：本机 settings 集合里这个键“活着”的那一行（没软删、没撤销）的 value；没有就是 undefined
// • 算写什么（settingWrite）：有这一行就 patch（内容由 setting-patch.ts 的 settingPatch 给，被软删、撤销过的顺带恢复），没有就 insert；
//   值一样不写（对象值按 JSON 比）
// • 写（createSettingWriter）：经 core/write（进 outbox、本机先生效）；同一页里的写一条接一条排队；
//   本机集合里还没出现刚 insert 的那一行时，按记下的 id patch、不再 insert 第二次（不然撞 (user_id, key) 唯一约束、进“发送失败”，代码审查 L6）。
//   要在原值上改的（往列表里加一项）用 update：排到了才按最新值算——本页写成功、本机集合还没跟上的，按本页最后写的值算，免得连点时后一下盖掉前一下。
//   React 那一层（kit/hooks/useSettingWriter.ts，提醒、日历、随手记共用）只管取本机集合和 error 状态
import { settingPatch } from './setting-patch.ts';
import { write } from './write.ts';

import { isLiveRow } from '../../shared/logic/live-row.ts';
import { settingValue, type SettingRow } from './setting-read.ts';

export { settingValue, type SettingRow } from './setting-read.ts';

export type SettingWrite =
  | { readonly op: 'insert'; readonly data: { readonly key: string; readonly value: unknown } }
  | { readonly op: 'patch'; readonly id: string; readonly data: Readonly<Record<string, unknown>> };

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 把 key 改成 value 要写什么；已经是这个值时 null（不写） */
export function settingWrite(rows: readonly SettingRow[], key: string, value: unknown): SettingWrite | null {
  const row = rows.find((r) => r.key === key && isLiveRow(r)) ?? rows.find((r) => r.key === key);
  if (!row) return { op: 'insert', data: { key, value } };
  if (isLiveRow(row) && typeof value === 'object' && value !== null && sameJson(row.value, value)) return null;
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
  /** 排队写一个键；值一样不写。回 true：写进本机了或值没变 */
  save(key: string, value: unknown): Promise<boolean>;
  /** 排队按原值算新值再写（排到了才算，原值取最新的）；新值一样不写。回值同 save */
  update(key: string, next: (cur: unknown) => unknown): Promise<boolean>;
}

/** 一页一个：排队、记下本页 insert 过的行（key → id）和本页写成功的最后一个值（写的时候集合里是什么、写了什么，都存 JSON） */
export function createSettingWriter(deps: SettingWriterDeps): SettingWriter {
  const inserted = new Map<string, string>();
  const wrote = new Map<string, { before: string | undefined; json: string }>();
  let queue: Promise<void> = Promise.resolve();

  /** 这个键现在的值：集合还停在本页上次写之前的样子（没跟上）就用本页最后写的，变过了（跟上了或别处改了）就用集合里的 */
  const latest = (key: string): unknown => {
    const v = settingValue(deps.rows(), key);
    const mine = wrote.get(key);
    if (mine !== undefined && JSON.stringify(v) === mine.before) return JSON.parse(mine.json) as unknown;
    wrote.delete(key);
    return v;
  };

  const saveNow = async (key: string, value: unknown): Promise<boolean> => {
    const cur = deps.rows();
    const id = inserted.get(key);
    const json = JSON.stringify(value);
    const before = JSON.stringify(settingValue(cur, key));
    const done = (ok: boolean): boolean => {
      if (ok) wrote.set(key, { before, json });
      deps.onResult(ok);
      return ok;
    };
    // 刚 insert 的那一行还没进本机集合：按记下的 id 改，值一样就不写
    if (id !== undefined && !cur.some((r) => r.key === key)) {
      if (wrote.get(key)?.json === json) return true;
      return done((await write.patch('settings', id, { value })).ok);
    }
    const w = settingWrite(cur, key, value);
    if (!w) return true;
    if (w.op === 'insert') {
      const newId = deps.newId();
      const r = await write.insert('settings', { id: newId, ...w.data });
      if (r.ok) inserted.set(key, newId);
      return done(r.ok);
    }
    return done((await write.patch('settings', w.id, w.data)).ok);
  };

  const update = (key: string, next: (cur: unknown) => unknown): Promise<boolean> => {
    const run = queue.then(() => saveNow(key, next(latest(key))));
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  return { update, save: (key, value) => update(key, () => value) };
}
