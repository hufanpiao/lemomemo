// 一行还在不在、一个分类还活着没有：月历、周视图、今天页、待办页、随手记、插图、分类合并和规则分类、ai-classify（经 _shared/gen 副本）用这一份。
// 仓库里还有几处自己写的同类判断没并进来（11-12 整合时：core/setting-read.ts、core/outbox-failed-create.ts、
//   reminders/data/reminder-model.ts、functions/_shared/consent.ts、push-dispatch/round-util.ts 两处），新代码请用这里的。
// 不变量：deleted_at 为 null 或没有这一列 = 没删；undone 不是 true = 没撤销（本机新建、还没同步的行可能没有这两列）；
//   活着的分类另要 merged_into 为空（没合并进别的分类）。纯函数。

/** 删除、撤销两列；值的类型不限 */
export interface Tombstone {
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}
/** 分类另看 merged_into */
type CategoryTombstone = Tombstone & { readonly merged_into?: unknown };
/** 本机缓存里的行（列都是 unknown）也能直接传进来 */
type AnyRow = Readonly<Record<string, unknown>>;

/** 这一行还在不在：没删、也没撤销 */
export function isLiveRow(r: Tombstone | AnyRow): boolean {
  const t = r as Tombstone;
  return (t.deleted_at ?? null) === null && t.undone !== true;
}

/** 活着的分类：还在（isLiveRow）、没合并进别的分类 */
export function isLiveCategory(c: CategoryTombstone | AnyRow): boolean {
  return isLiveRow(c) && ((c as CategoryTombstone).merged_into ?? null) === null;
}
