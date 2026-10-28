// 纪念日（0005_anniv.sql）：anniversaries；头像在 images 桶的 <user_id>/anniv/ 段（桶归 notes）
import { defineManifest } from '../schema/manifest.ts';
import { BY_USER, SOFT_DELETE_COLS, UUID_RE } from './_common.ts';

export const anniv = defineManifest({
  feature: 'anniv',
  owner: 'feature',
  tables: [
    { name: 'anniversaries', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'kind', 'name', 'calendar', 'lunar_variant', 'month', 'day', 'is_leap', 'year', 'remind_offsets', 'remind_time',
        'after_due', 'push_show_title', 'notified_for', 'snooze_at', 'note', 'created_at', 'updated_at', 'avatar_id', 'avatar_bytes', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'created_at'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: ['pushed_for', 'defer_until', 'remind_at', 'next_date', 'archived_at'], noConflict: ['notified_for', 'snooze_at', 'updated_at'] },
  ],
  buckets: [
    { name: 'images', pathPrefix: '<user_id>/anniv/', pathPattern: `^${UUID_RE}/anniv/${UUID_RE}/${UUID_RE}\\.webp$`,
      backup: 'weekly-s3', export: 'zip', countsToQuota: true,
      orphanSweep: { after: '24 hours', table: 'anniversaries', col: 'avatar_id' }, userLookup: { by: 'pathPattern', level: 1 } },
  ],
  recordKinds: [
    { kind: 'anniv', table: 'anniversaries', flag: 'anniv', ai: { parse: true, intent: true }, plusResult: true, vector: null },
  ],
  settingsKeys: ['anniv.*'],
  usageReport: { rows: true, buckets: false },
});
