// 日程（0002_calendar_todos.sql 的 events）
import { defineManifest } from '../schema/manifest.ts';
import { BY_USER, SOFT_DELETE_COLS } from './_common.ts';

export const calendar = defineManifest({
  feature: 'calendar',
  owner: 'feature',
  tables: [
    { name: 'events', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'title', 'date', 'time', 'tz', 'duration_min', 'project', 'note', 'source', 'raw_text', 'location',
        'short', 'short_by', 'push_show_title', 'batch_id', 'remind_min', 'remind_days', 'notified_for', 'snooze_at',
        'created_at', 'updated_at', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'created_at'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: ['pushed_for', 'defer_until', 'ai_status', 'remind_at'], noConflict: ['notified_for', 'snooze_at', 'updated_at'] },
  ],
  recordKinds: [
    { kind: 'event', table: 'events', flag: 'event', ai: { parse: true, intent: true }, plusResult: true, vector: { fk: 'event_id' } },
  ],
  ai: { sendsToAI: true, functions: ['ai-parse', 'ai-voice', 'ai-embed'], vectors: { events: ['title', 'note', 'location'] } },
  usageReport: { rows: true, buckets: false },
});
