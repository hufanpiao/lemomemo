// 传输层把令牌定死在请求上（K6-sugg5 ④(b)）：发之前 getSession 读出令牌、显式设成 Authorization，
// 失败时带回这个令牌的 session_id（SendFailure.sid）——send.ts 据此只删真正发出去的那个会话
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseTransport } from '../../../platform/supabase/sync-transport.ts';

const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const args = { p_table: 'todos', p_id: 'x', p_patch: {}, p_base_rev: 1, p_op_id: 'o', p_own_revs: [] };
const revoked = { data: null, error: { message: 'session_revoked', code: 'P0001' }, status: 400 };

/** rpc 回 revoked；session：getSession 的结果（'throw' = 抛错）；withSetHeader：builder 有没有 setHeader */
function client(session: { access_token?: string } | null | 'throw', withSetHeader = true) {
  const headers: [string, string][] = [];
  const b: Record<string, unknown> = {
    abortSignal: () => b,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(revoked).then(res, rej),
  };
  if (withSetHeader) {
    b['setHeader'] = (n: string, v: string) => {
      headers.push([n, v]);
      return b;
    };
  }
  const db = {
    rpc: () => b,
    auth: {
      getSession: () => (session === 'throw' ? Promise.reject(new Error('lock')) : Promise.resolve({ data: { session } })),
    },
  } as unknown as SupabaseClient;
  return { db, headers };
}

async function patch(c: ReturnType<typeof client>) {
  const t = createSupabaseTransport({ client: () => Promise.resolve(c.db), sessionId: () => 'ignored' });
  return t.applyPatch(args);
}

describe('传输层定死令牌、带回 sid（K6-sugg5 ④(b)）', () => {
  it('有会话：Authorization 设成这个令牌；失败带回它的 session_id', async () => {
    const c = client({ access_token: tok('s2') });
    const r = await patch(c);
    expect(c.headers).toEqual([['Authorization', `Bearer ${tok('s2')}`]]);
    expect(r).toEqual({ ok: false, error: { status: 400, code: 'session_revoked', sid: 's2' } });
  });

  it('没有会话：不设 Authorization（supabase-js 带 anon key），失败带回 sid: null', async () => {
    const c = client(null);
    const r = await patch(c);
    expect(c.headers).toEqual([]);
    expect(r).toEqual({ ok: false, error: { status: 400, code: 'session_revoked', sid: null } });
  });

  it('getSession 抛错、builder 没有 setHeader：定不住令牌，不带 sid（send.ts 用发之前读的）', async () => {
    for (const c of [client('throw'), client({ access_token: tok('s2') }, false)]) {
      const r = await patch(c);
      expect(c.headers).toEqual([]);
      expect(r).toEqual({ ok: false, error: { status: 400, code: 'session_revoked' } });
    }
  });
});
