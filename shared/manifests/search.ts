// 按意思查找（0007_search.sql；核心清单）：note_vectors、embed_queue。一张表服务五种数据，各功能在自己的清单里写 ai.vectors
import { defineManifest, type ManifestTableInput } from '../schema/manifest.ts';
import { BY_USER } from './_common.ts';

const priv = { schema: 'private', sync: false, realtime: false, localCache: 'none', clientWritable: [], softDelete: false,
  backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER } satisfies Partial<ManifestTableInput>;   // 能重算，不备份（export: none，续第 83 条）

export const search = defineManifest({
  feature: 'search',
  owner: 'core',
  tables: [
    { ...priv, name: 'note_vectors' },
    { ...priv, name: 'embed_queue' },
  ],
  extraEmbedSources: ['private.vault_ai'],   // 隐私记图片、文档的描述（0.27②）
  usageReport: { rows: true, buckets: false },
});
