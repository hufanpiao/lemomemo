// 文档附件（0004_attachments.sql）：note_files、files 桶
import { defineManifest } from '../schema/manifest.ts';
import { BY_USER, COMMON_COLS, SOFT_DELETE_COLS, UUID_RE } from './_common.ts';

/** 10 种文档的 MIME（R-114 D-4）；files 桶另加 image/webp 放缩略图 */
export const DOC_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
];

export const attachments = defineManifest({
  feature: 'attachments',
  owner: 'feature',
  tables: [
    { name: 'note_files', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'note_id', 'kind', 'path', 'has_thumb', 'name', 'mime', 'bytes', 'sha256', 'pages', 'text_excerpt',
        'created_at', 'updated_at', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'note_id', 'kind', 'path', 'has_thumb', 'mime', 'bytes', 'sha256', 'pages', 'text_excerpt', 'created_at'],
      updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      vaultRows: { flag: 'is_vault', cipherCols: ['name_enc', 'text_enc', 'dek_enc', 'enc_key_id'],
        plainColsMustBeNull: ['name', 'text_excerpt', 'ai_desc', 'ai_tags'],
        neutralCols: [...COMMON_COLS, 'note_id', 'kind', 'path', 'has_thumb', 'is_vault', 'mime', 'bytes', 'sha256', 'pages',
          'etag', 'check_status', 'ai_status', 'skip_reason', 'ai_tries', 'ai_next_at', 'created_at', 'updated_at'] },
      systemCols: ['ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at', 'check_status', 'etag'], noConflict: ['updated_at'] },
  ],
  buckets: [
    { name: 'files', store: 'r2', limits: { fileSizeLimit: 10485760, allowedMimeTypes: [...DOC_MIME, 'image/webp'] },
      pathPrefix: '<user_id>/', pathPattern: `^${UUID_RE}/${UUID_RE}/${UUID_RE}(\\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\\.t\\.webp)$`,
      backup: 'weekly-s3', export: 'zip', countsToQuota: true,
      orphanSweep: { after: '24 hours', table: 'note_files', col: 'path' }, userLookup: { by: 'pathPattern', level: 1 } },
  ],
  recordKinds: [
    { kind: 'file', table: 'note_files', flag: 'note', ai: { parse: false, intent: false }, plusResult: true, vector: { fk: 'file_id' } },
  ],
  ai: { sendsToAI: true, functions: ['ai-media', 'ai-embed'], vectors: { note_files: ['ai_desc', 'ai_tags', 'name', 'text_excerpt'] } },
  usageReport: { rows: true, buckets: true },
});
