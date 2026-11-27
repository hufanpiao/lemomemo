// 隐私记（0006_vault.sql；核心清单，3.5 第 5 点）：五张 private 表、三个隐私桶；只经 fn_vault / fn_ai，不给服务端的 service 角色（A14 不准源码里出现那个角色名，B0 集成改写这句注释）
import { defineManifest, type ManifestTableInput } from '../schema/manifest.ts';
import { BY_USER, UUID_RE } from './_common.ts';

const priv = { schema: 'private', sync: false, realtime: false, localCache: 'none', clientWritable: [], softDelete: false,
  export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER } satisfies Partial<ManifestTableInput>;   // 五张表 export: none（0.29 续第 83 条）

export const vault = defineManifest({
  feature: 'vault',
  owner: 'core',
  tables: [
    { ...priv, name: 'vault', backup: 'json' },
    { ...priv, name: 'vault_credentials', backup: 'json' },
    { ...priv, name: 'device_secrets', backup: 'json' },
    { ...priv, name: 'vault_ai', backup: 'json' },
    { ...priv, name: 'vault_preview', backup: 'none' },
  ],
  buckets: [
    { name: 'vault-images', store: 'r2', limits: { fileSizeLimit: 2097152, allowedMimeTypes: ['image/webp'] },
      pathPrefix: '<user_id>/', pathPattern: `^${UUID_RE}/${UUID_RE}/${UUID_RE}(\\.t)?\\.webp$`,
      backup: 'weekly-s3', export: 'none', countsToQuota: true,   // R-184：隐私桶不进导出
      orphanSweep: { after: '24 hours', table: 'note_images', col: 'path' }, userLookup: { by: 'pathPattern', level: 1 } },
    { name: 'vault-files', store: 'r2', limits: { fileSizeLimit: 10551296, allowedMimeTypes: ['application/octet-stream'] },
      pathPrefix: '<user_id>/', pathPattern: `^${UUID_RE}/${UUID_RE}/${UUID_RE}(\\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\\.t\\.webp)$`,
      backup: 'weekly-s3', export: 'none', countsToQuota: true,
      orphanSweep: { after: '24 hours', table: 'note_files', col: 'path' }, userLookup: { by: 'pathPattern', level: 1 } },
    { name: 'vault-preview', store: 'supabase',
      limits: { fileSizeLimit: 10485760, allowedMimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
      pathPrefix: '', pathPattern: '^[0-9a-f]{32}\\.pptx$',   // 随机路径，不含 user_id
      backup: 'none', export: 'none', countsToQuota: false, orphanSweep: null, maxLifetime: 'link_ttl + 1 minute',
      userLookup: { by: 'registry', table: 'private.vault_preview', col: 'user_id' } },
  ],
  settingsKeys: ['vault.*'],
  usageReport: { rows: true, buckets: true },
});
