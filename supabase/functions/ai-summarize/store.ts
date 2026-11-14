// ai-summarize 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser 事务里，app.uid 已设好，fn_own / fn_own_ai 策略只放本人的行）。
// 用到的授权：0002、0003 的列级 select 加迁移 20261115073000（events.date、time、tz、undone，todos.due、due_time、done、undone，notes.created_at、undone）。
// 只读没删（deleted_at is null）、没撤销（not undone）的；日子转成文字再出库（date 类型不经 JS 的 Date，免得按时区挪一天）。
// 真库用例：supabase/tests/rls/63_ai_summarize_fn_ai_reads.test.sql 跑的就是这三句。
import type { Tx } from '../_shared/db.ts';
import type { SummaryRow } from './core.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 按 id 读本人的日程、待办、随手记（查不到的不出现，core 当 missing） */
export async function loadRows(tx: Tx, uid: string, ids: { event: string[]; todo: string[]; note: string[] }): Promise<SummaryRow[]> {
  const out: SummaryRow[] = [];
  if (ids.event.length > 0) {
    for (const r of await tx`select id, title, date::text as date, time, tz, location, note from public.events
        where user_id = ${uid} and id = any(${ids.event}::uuid[]) and deleted_at is null and not undone`) {
      out.push({ kind: 'event', id: String(r['id']), title: str(r['title']), date: str(r['date']), time: str(r['time']), tz: str(r['tz']), where: str(r['location']), body: str(r['note']) });
    }
  }
  if (ids.todo.length > 0) {
    for (const r of await tx`select id, title, due::text as due, due_time, done, note from public.todos
        where user_id = ${uid} and id = any(${ids.todo}::uuid[]) and deleted_at is null and not undone`) {
      out.push({ kind: 'todo', id: String(r['id']), title: str(r['title']), date: str(r['due']), time: str(r['due_time']), done: r['done'] === true, body: str(r['note']) });
    }
  }
  if (ids.note.length > 0) {
    for (const r of await tx`select id, title, body, is_private, created_at from public.notes
        where user_id = ${uid} and id = any(${ids.note}::uuid[]) and deleted_at is null and not undone`) {
      out.push({
        kind: 'note', id: String(r['id']), title: str(r['title']), body: str(r['body']), createdAt: Number(r['created_at']), isPrivate: r['is_private'] === true,
      });
    }
  }
  return out;
}
