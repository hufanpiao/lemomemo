// 待办（0002_calendar_todos.sql 的 todos）
import { defineManifest } from '../schema/manifest.ts';
import { BY_USER, SOFT_DELETE_COLS } from './_common.ts';

export const todos = defineManifest({
  feature: 'todos',
  owner: 'feature',
  tables: [
    { name: 'todos', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'title', 'done', 'due', 'important', 'project', 'note', 'source', 'raw_text', 'batch_id',
        'from_note_id', 'from_anniv_id', 'short', 'short_by', 'done_at', 'remind_days', 'remind_time', 'due_time', 'remind_before_min',
        'push_show_title', 'notified_for', 'snooze_at', 'created_at', 'updated_at', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'created_at'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: ['pushed_for', 'defer_until', 'ai_status', 'remind_at'], noConflict: ['notified_for', 'snooze_at', 'updated_at'] },
  ],
  recordKinds: [
    { kind: 'todo', table: 'todos', flag: 'todo', ai: { parse: true, intent: true }, plusResult: true, vector: { fk: 'todo_id' } },
  ],
  ai: { sendsToAI: true, functions: ['ai-parse', 'ai-voice', 'ai-embed'], vectors: { todos: ['title', 'note'] } },   // todos 没有 location（P-03）
  usageReport: { rows: true, buckets: false },
});
