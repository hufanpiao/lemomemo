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

/** 要同步到本机的表（sync: true），本机缓存按它建 store */
export function syncTables(list: readonly Manifest[] = manifests): ManifestTable[] {
  return allTables(list).filter((t) => t.sync);
}

/** 某张表的客户端可写列；没登记的表返回 null（outbox 拒收） */
export function clientWritableOf(table: string, list: readonly Manifest[] = manifests): readonly string[] | null {
  const t = allTables(list).find((x) => x.schema === 'public' && x.name === table);
  return t ? t.clientWritable : null;
}
