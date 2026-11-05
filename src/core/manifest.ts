// 汇总所有数据清单（架构 3.5 第 2 点）：本机缓存、outbox、sync 按这里建 store、校验可写列，不手写表清单
// 默认用完整快照（manifest-source.ts → manifests.gen.ts）。11-05 首屏瘦身起首屏不引本文件：
// 建本机仓读 manifest-sync.gen.ts（cache-schema.ts），入队校验的完整清单随 rows.ts 按需加载（outbox-logic.ts），函数本体在 manifest-tables.ts
// 纯 TS：不准 import React 和任何功能（A1）
import { manifests, type Manifest, type ManifestTable } from './manifest-source.ts';
import * as pure from './manifest-tables.ts';

export type { Manifest, ManifestTable };

/** 所有清单里的表（同名表只能有一个主人：重复登记直接报错） */
export function allTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return pure.allTables(list);
}

/** 要同步到本机、按它建本机仓的表（sync: true）；墓碑表不算，见 tombstoneTables */
export function syncTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return pure.syncTables(list);
}

/** 墓碑表（sync: 'tombstone'）：sync 按它拉“别处已删除”的记录，再删本机仓里对应的行 */
export function tombstoneTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return pure.tombstoneTables(list);
}

/** 某张表的客户端可写列；没登记的表返回 null（outbox 拒收） */
export function clientWritableOf(table: string, list: readonly Manifest[] = manifests): readonly string[] | null {
  return pure.clientWritableOf(table, list);
}
