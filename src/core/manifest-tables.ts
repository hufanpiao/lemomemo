// 从清单列表里取表（纯函数，不带清单数据；11-05 首屏瘦身）：调用方必须传清单。
// 默认用完整清单的版本在 manifest.ts（它 import 完整快照 manifests.gen.ts，不进首屏；拆出去以后首屏实测少 2.4 KB 左右）；
// 首屏建本机仓只要表名这几项，读 manifest-sync.gen.ts（cache-schema.ts）；入队校验要的完整清单和 rows.ts 一起按需加载（outbox-logic.ts 的 loadRowSchemas）
// 纯 TS：不准 import React 和任何功能（A1）
import type { Manifest, ManifestTable } from '../../shared/schema/manifest.ts';

/** 所有清单里的表（同名表只能有一个主人：重复登记直接报错） */
export function allTables(list: readonly Manifest[]): ManifestTable[] {
  const seen = new Map<string, string>();
  const out: ManifestTable[] = [];
  for (const m of list) {
    for (const t of m.tables) {
      const key = `${t.schema}.${t.name}`;
      const owner = seen.get(key);
      if (owner) throw new Error(`manifest_duplicate_table:${key}:${owner}:${m.feature}`);
      seen.set(key, m.feature);
      out.push(t);
    }
  }
  return out;
}

/**
 * 要同步到本机、按它建本机仓的表（sync: true）。
 * sync: 'tombstone'（只有 tombstones）不算：不建本机仓，按 deleted_at 增量拉、只订阅 INSERT（数据字典 4.3b），见 tombstoneTables
 */
export function syncTables(list: readonly Manifest[]): ManifestTable[] {
  return allTables(list).filter(isSyncTable);
}

/**
 * 一张表要不要建本机仓（sync: true）。syncTables 和 cache-schema.ts 读精简清单 manifest-sync.gen.ts 时共用这一处（审查 L2）。
 * 精简清单不经 allTables，“同名表只能有一个主人”的检查由 __tests__/manifest-snapshot.test.ts 兜：
 * 它对完整快照跑 allTables，并核对精简清单逐表等于完整快照
 */
export function isSyncTable(t: Pick<ManifestTable, 'sync'>): boolean {
  return t.sync === true;
}

/** 墓碑表（sync: 'tombstone'）：sync 按它拉“别处已删除”的记录，再删本机仓里对应的行 */
export function tombstoneTables(list: readonly Manifest[]): ManifestTable[] {
  return allTables(list).filter((t) => t.sync === 'tombstone');
}

/** 某张表的客户端可写列；没登记的表返回 null（outbox 拒收） */
export function clientWritableOf(table: string, list: readonly Manifest[]): readonly string[] | null {
  const t = allTables(list).find((x) => x.schema === 'public' && x.name === table);
  return t ? t.clientWritable : null;
}
