// 一行还在不在、一个分类还活着没有：月历、周视图、今天页、待办页、随手记、插图、分类合并和规则分类、设置读写、离线队列建失败、提醒，
//   ai-classify（经 _shared/gen 副本）用这一份。新代码请用这里的。
// 有意不用这份的（11-12 整合评审核过）：core/setting-patch.ts（要分开知道是删了还是撤销了，决定恢复哪一列）、
//   kit/hooks/useEditRecord.ts（只看删没删，撤销另算）、functions/_shared/consent.ts（服务器函数不能直接引 shared，语义相同）、
//   push-dispatch/round-util.ts（服务器函数；deleted_at 缺这一列时它当成删了，和这里相反）。
// 不变量：deleted_at 为 null 或没有这一列 = 没删；undone 不是 true = 没撤销（本机新建、还没同步的行可能没有这两列）；
//   活着的分类另要 merged_into 为空（没合并进别的分类）。纯函数。

/** 删除、撤销两列；值的类型不限 */
export interface Tombstone {
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}
/** 分类另看 merged_into */
interface CategoryTombstone extends Tombstone {
  readonly merged_into?: unknown;
}
/** 传给分类合并建议、本机规则分类的一个分类（删了的、撤销的、合并掉的照样传进去，由 isLiveCategory 跳过） */
export interface CategoryRow extends CategoryTombstone {
  readonly id: string;
  readonly name: string;
  readonly sort?: number;
}
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
