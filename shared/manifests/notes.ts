// 随手记（0003_notes.sql）：categories、notes、note_images、images 桶（头像段由 anniv 登记）
import { defineManifest } from '../schema/manifest.ts';
import { BY_USER, COMMON_COLS, SOFT_DELETE_COLS, UUID_RE } from './_common.ts';

export const notes = defineManifest({
  feature: 'notes',
  owner: 'feature',
  tables: [
    { name: 'categories', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'name', 'color', 'sort', 'created_by', 'merged_into', ...SOFT_DELETE_COLS],
      insertOnly: ['id'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: [], noConflict: ['sort'] },
    { name: 'notes', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'title', 'body', 'is_private', 'category_id', 'category_source', 'category_seen', 'tags', 'converted_to',
        'source', 'raw_text', 'batch_id', 'created_at', 'updated_at', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'is_private', 'created_at'], updateOnly: [...SOFT_DELETE_COLS],   // is_private 只能 insert false（RLS）
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      vaultRows: { flag: 'is_private', cipherCols: ['body_enc', 'enc_key_id'],
        plainColsMustBeNull: ['title', 'body', 'raw_text', 'tags', 'ai_meta', 'converted_to'],
        neutralCols: [...COMMON_COLS, 'is_private', 'category_id', 'category_source', 'category_seen', 'ai_status', 'source', 'batch_id', 'created_at', 'updated_at'] },
      systemCols: ['ai_status', 'ai_meta'], noConflict: ['updated_at'] },
    { name: 'note_images', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'note_id', 'bucket', 'path', 'bytes', 'width', 'height', 'mime', 'taken_at', 'has_thumb', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'note_id', 'bucket', 'path', 'bytes', 'width', 'height', 'mime', 'taken_at', 'has_thumb'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      vaultRows: { flag: "bucket = 'vault-images'", cipherCols: [],   // 隐私记图片的描述加密存 private.vault_ai
        plainColsMustBeNull: ['taken_at', 'ai_desc', 'ai_tags'],
        neutralCols: [...COMMON_COLS, 'note_id', 'bucket', 'path', 'bytes', 'width', 'height', 'mime', 'has_thumb', 'ai_status', 'skip_reason', 'ai_tries', 'ai_next_at'] },
      systemCols: ['ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'], noConflict: [] },
  ],
  buckets: [
    { name: 'images', store: 'r2', limits: { fileSizeLimit: 2097152, allowedMimeTypes: ['image/webp'] },
      pathPrefix: '<user_id>/', pathPattern: `^${UUID_RE}/${UUID_RE}/${UUID_RE}(\\.t)?\\.webp$`,
      backup: 'weekly-s3', export: 'zip', countsToQuota: true,
      orphanSweep: { after: '24 hours', table: 'note_images', col: 'path' }, userLookup: { by: 'pathPattern', level: 1 } },
  ],
  recordKinds: [
    { kind: 'note', table: 'notes', flag: 'note', ai: { parse: true, intent: true }, plusResult: true, vector: { fk: 'note_id' } },
    { kind: 'image', table: 'note_images', flag: 'note', ai: { parse: false, intent: false }, plusResult: true, vector: { fk: 'image_id' } },
  ],
  ai: { sendsToAI: true, functions: ['ai-classify', 'ai-media', 'ai-embed'],
    vectors: { notes: ['title', 'body', 'body_enc', 'category_id', 'is_private'], note_images: ['ai_desc', 'ai_tags'] } },
  settingsKeys: ['notes.*'],
  usageReport: { rows: true, buckets: true },
});
