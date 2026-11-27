// 样例清单：只用来测生成器，覆盖每一种找人方式（3.5 userLookup）、noUserData、分段登记的桶、vaultRows、本机仓。
// 不是正式清单，列和取值是从数据字典 v4 第 12 节摘的一部分；正式清单在 shared/manifests/（后端写）。

import type { Manifest } from './types.ts';

export const sampleCore: Manifest = {
  feature: 'core',
  owner: 'core',
  tables: [
    { name: 'profiles', schema: 'public', sync: false, userLookup: { by: 'column', col: 'id' }, onAccountDelete: 'cascade' },
    {
      name: 'settings',
      schema: 'public',
      sync: true,
      softDelete: true,
      clientWritable: ['key', 'value', 'deleted_at', 'updated_at'],
      systemCols: [],
      userLookup: { by: 'column', col: 'user_id' },
      onAccountDelete: 'cascade',
    },
    { name: 'app_config', schema: 'public', sync: false, noUserData: true },
    { name: 'counters', schema: 'private', sync: false, userLookup: { by: 'keyPattern', col: 'key', pattern: '%:<user>:%' } },
    { name: 'pending_signups', schema: 'private', sync: false, userLookup: { by: 'emailHash', col: 'email_hash' } },
    { name: 'tombstones', schema: 'public', sync: 'tombstone', userLookup: { by: 'column', col: 'user_id' } },
  ],
  buckets: [{ name: 'backups', userLookup: { by: 'pathPattern', level: 2 } }],
  localStores: [{ name: 'meta', rebuildable: false }, { name: 'outbox', rebuildable: false }],
};

export const sampleNotes: Manifest = {
  feature: 'notes',
  owner: 'notes',
  tables: [
    {
      name: 'notes',
      schema: 'public',
      sync: true,
      softDelete: true,
      clientWritable: ['body', 'category_id', 'deleted_at', 'updated_at'],
      systemCols: ['ai_meta'],
      vaultRows: {
        flag: 'is_private',
        cipherCols: ['body_enc'],
        plainColsMustBeNull: ['body', 'raw_text', 'tags', 'ai_meta', 'converted_to'],
        neutralCols: ['id', 'user_id', 'rev', 'created_at', 'updated_at', 'deleted_at', 'is_private'],
      },
      userLookup: { by: 'column', col: 'user_id' },
    },
  ],
  buckets: [
    {
      name: 'images',
      pathPrefix: '<user_id>/',
      pathPattern: '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.t)?\\.webp$',
      orphanSweep: { after: '24 hours', table: 'public.note_images', col: 'path' },
      userLookup: { by: 'pathPattern', level: 1 },
    },
  ],
};

export const sampleAnniv: Manifest = {
  feature: 'anniv',
  owner: 'anniv',
  tables: [],
  // 纪念日头像在 images 桶里，由 anniv 登记自己那一段（3.5 “一条原则”）
  buckets: [{ name: 'images', pathPrefix: '<user_id>/anniv/', userLookup: { by: 'pathPattern', level: 1 } }],
};

export const sampleVault: Manifest = {
  feature: 'vault',
  owner: 'core',
  tables: [{ name: 'vault_preview', schema: 'private', sync: false, userLookup: { by: 'column', col: 'user_id' } }],
  buckets: [
    {
      name: 'vault-preview',
      maxLifetime: '链接有效期 + 1 分钟',
      userLookup: { by: 'registry', table: 'private.vault_preview', col: 'user_id', pathCol: 'path' },
    },
  ],
};

export const sampleManifests: readonly Manifest[] = [sampleCore, sampleNotes, sampleAnniv, sampleVault];
