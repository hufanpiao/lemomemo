// 汇总所有数据清单（架构 3.5 第 2 点）：本机缓存、outbox、sync 按这里建 store、校验可写列，不手写表清单
// 纯 TS：不准 import React 和任何功能（A1）
import { manifests, type Manifest, type ManifestTable } from './manifest-source.ts';

export type { Manifest, ManifestTable };

/** 所有清单里的表（同名表只能有一个主人：重复登记直接报错） */
export function allTables(list: readonly Manifest[] = manifests): ManifestTable[] {
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
export function syncTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return allTables(list).filter((t) => t.sync === true);
}

/** 墓碑表（sync: 'tombstone'）：sync 按它拉“别处已删除”的记录，再删本机仓里对应的行 */
export function tombstoneTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return allTables(list).filter((t) => t.sync === 'tombstone');
}

/** 某张表的客户端可写列；没登记的表返回 null（outbox 拒收） */
export function clientWritableOf(table: string, list: readonly Manifest[] = manifests): readonly string[] | null {
  const t = allTables(list).find((x) => x.schema === 'public' && x.name === table);
  return t ? t.clientWritable : null;
}
