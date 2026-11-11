// ai-classify 的库读写（service role 的 supabase-js；架构 5.2、附录 A 的 categories 一行“客户端 + ai-classify 函数”）。
// 只碰：public.notes（经 private.ai_classify_pending 按人读 pending、带条件写回分类）、public.categories（读、新建 AI 提议的分类）、private.heartbeat（心跳）。
// service role 绕过 RLS，所以每一句都按 user_id 自己过滤。出错一律抛错（core.ts 按条记 failed 或跳过），日志只记错误码。
import type { ClassifyStore, HeartbeatDetail } from './core.ts';
import { HEARTBEAT } from './core.ts';
import type { PendingNote } from './request.ts';
import type { Category, NotePatch } from './write.ts';

type Res = { data: unknown; error: unknown };
interface Q extends PromiseLike<Res> {
  select(cols: string): Q;
  eq(col: string, v: string | number | boolean): Q;
  neq(col: string, v: string): Q;
  in(col: string, v: readonly string[]): Q;
  is(col: string, v: null): Q;
  order(col: string, o: { ascending: boolean }): Q;
  limit(n: number): Q;
  update(v: Record<string, unknown>): Q;
  insert(v: Record<string, unknown>): Q;
  upsert(v: Record<string, unknown>, o?: Record<string, unknown>): Q;
}
/** service role 的 supabase-js 客户端（from 写成 unknown，原因同 _shared/consent.ts 的 ConsentAdmin） */
export interface ClassifyAdmin {
  from(t: string): unknown;
  schema(s: 'private'): unknown;
}

const must = (r: Res, what: string): unknown => {
  if (r.error) throw new Error(`db:${what}`);
  return r.data;
};
const tbl = (s: { from(t: string): unknown }, t: string): Q => s.from(t) as Q;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function makeStore(admin: ClassifyAdmin): ClassifyStore {
  const priv = admin.schema('private') as { from(t: string): unknown; rpc(f: string, a: Record<string, unknown>): PromiseLike<Res> };
  return {
    async requeue() {
      const d = must(await tbl(admin, 'notes').update({ ai_status: 'pending' })
        .eq('ai_status', 'rule').eq('is_private', false).in('ai_meta->>retry', ['quota', 'error']).select('id'), 'requeue');
      return Array.isArray(d) ? d.length : 0;
    },
    async pending(perUser, users) {
      // 按人取（代码审查 11-10 必改 1）：一个人堆再多也只占一个位置，见迁移 20261110121000
      const d = must(await priv.rpc('ai_classify_pending', { p_per_user: perUser, p_users: users }), 'pending');
      const out: PendingNote[] = [];
      for (const r of Array.isArray(d) ? d : []) {
        if (!isObj(r) || !str(r['id']) || !str(r['user_id'])) continue;
        out.push({
          id: r['id'] as string, user_id: r['user_id'] as string, title: str(r['title']), body: str(r['body']),
          tags: Array.isArray(r['tags']) ? r['tags'].filter((x): x is string => typeof x === 'string') : null,
          category_source: str(r['category_source']) ?? 'none', ai_meta: r['ai_meta'] ?? null,
        });
      }
      return out;
    },
    async categories(userId) {
      const d = must(await tbl(admin, 'categories').select('id, name, sort, deleted_at, undone, merged_into').eq('user_id', userId), 'categories');
      const out: Category[] = [];
      for (const r of Array.isArray(d) ? d : []) {
        if (!isObj(r) || !str(r['id']) || !str(r['name'])) continue;
        out.push({
          id: r['id'] as string, name: r['name'] as string, sort: typeof r['sort'] === 'number' ? r['sort'] : 0,
          deleted_at: typeof r['deleted_at'] === 'number' ? r['deleted_at'] : null, undone: r['undone'] === true, merged_into: str(r['merged_into']),
        });
      }
      return out;
    },
    async createCategory(userId, c) {
      must(await tbl(admin, 'categories').insert({ id: c.id, user_id: userId, name: c.name, sort: c.sort, created_by: 'ai' }), 'category_insert');
    },
    async writeNote(userId, noteId, patch: NotePatch, manual) {
      const q = tbl(admin, 'notes').update({ ...patch }).eq('id', noteId).eq('user_id', userId).eq('ai_status', 'pending');
      must(await (manual ? q.eq('category_source', 'manual') : q.neq('category_source', 'manual')), 'note_write');
    },
    async writeHeartbeat(detail: HeartbeatDetail) {
      must(await tbl(priv, 'heartbeat').upsert({ name: HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' }), 'heartbeat');
    },
  };
}
