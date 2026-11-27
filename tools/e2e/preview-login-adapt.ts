// tools/e2e/preview-login.ts 的适配层：supabase-js 客户端 → AdminOps（从 preview-login.ts 拆出来，免得单个文件超过 300 行）
// 远端返回的值逐个核类型，形状不对一律当出错（脚本的护栏把“出错”当“查不清”，不签发、不写库）
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminOps } from './preview-login.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function adaptClient(c: SupabaseClient): AdminOps {
  return {
    async adminIds() {
      const { data, error, count } = await c.schema('private').from('admins').select('user_id', { count: 'exact' });
      if (error || !Array.isArray(data)) return { ids: null, count: null, error: true };
      const ids: string[] = [];
      for (const row of data as unknown[]) {
        const id = typeof row === 'object' && row !== null && 'user_id' in row ? str(row.user_id) : null;
        if (id === null) return { ids: null, count: null, error: true };
        ids.push(id);
      }
      return { ids, count: count ?? null, error: false };
    },
    async userEmail(id) {
      const { data, error } = await c.auth.admin.getUserById(id);
      if (error) return { found: false, email: null, error: true };
      return { found: data.user !== null, email: data.user?.email ?? null, error: false };
    },
    async listUsers(page, perPage) {
      const bad = { users: null, nextPage: null, total: 0, error: true } as const;
      const { data, error } = await c.auth.admin.listUsers({ page, perPage });
      if (error) return bad;
      // auth-js 没有 Link 头时 nextPage 为 null、total 为 0；total 解析不出数（NaN）当出错
      const total: unknown = data.total;
      const next: unknown = data.nextPage;
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return bad;
      const users: { id: string; email: string | null }[] = [];
      for (const u of data.users) {
        const id = str(u.id);
        if (id === null) return bad;
        users.push({ id, email: str(u.email) });
      }
      return { users, nextPage: typeof next === 'number' ? next : null, total, error: false };
    },
    async insertAdmin(userId) {
      const { error } = await c.schema('private').from('admins').insert({ user_id: userId });
      return { error: error !== null };
    },
    async generateLink(email) {
      const { data, error } = await c.auth.admin.generateLink({ type: 'magiclink', email });
      const p = data.properties;
      return {
        properties: p ? { email_otp: p.email_otp, action_link: p.action_link, hashed_token: p.hashed_token } : null,
        error: error !== null,
      };
    },
  };
}
