// 申请注销回 try_later 后先查真实状态（架构 0.47 第 22 条 T4、安全审查 H1；data/deletion-check.ts）
import { describe, expect, it, vi } from 'vitest';
import type { AccountProbe } from '../../../platform/account-status.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { checkDeletion, deletionAfterProbe } from '../data/deletion-check.ts';

const b64 = (o: unknown): string => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenOf = (sid: string): string => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', session_id: sid })}.sig`;

function db(token: string | null, invoke?: (name: string, o: unknown) => Promise<unknown>): () => Promise<Db> {
  return async () =>
    ({
      auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null }, error: null }) },
      functions: { invoke: invoke ?? (async () => ({ data: null, error: new Error('x') })) },
    }) as unknown as Db;
}

describe('deletionAfterProbe', () => {
  it('冷静期 → 已办成；会话已失效 → 确认不了（H1：不说冷静期）；active → 没办成；disabled → 停用；unknown → 判断不了', () => {
    expect(deletionAfterProbe({ kind: 'pending_deletion', purgeAfter: '2026-11-06T15:30:00Z' })).toEqual({ kind: 'done', purgeAfter: '2026-11-06T15:30:00Z' });
    expect(deletionAfterProbe({ kind: 'pending_deletion', purgeAfter: null })).toEqual({ kind: 'done', purgeAfter: null });
    // signed_out 包括 session_revoked 和 unauthorized（platform/account-status.ts 的 SIGNED_OUT_CODES）
    expect(deletionAfterProbe({ kind: 'signed_out' })).toEqual({ kind: 'unsure' });
    expect(deletionAfterProbe({ kind: 'active' })).toEqual({ kind: 'not_done' });
    expect(deletionAfterProbe({ kind: 'disabled' })).toEqual({ kind: 'disabled' });
    expect(deletionAfterProbe({ kind: 'unknown' })).toEqual({ kind: 'unknown' });
  });
});

describe('checkDeletion', () => {
  it('用本机同一个会话的令牌去查', async () => {
    const t = tokenOf('s-1');
    const probe = vi.fn(async (_t: string): Promise<AccountProbe> => ({ kind: 'pending_deletion', purgeAfter: '2026-11-06T15:30:00Z' }));
    expect(await checkDeletion(db(t), 's-1', { probe })).toEqual({ kind: 'done', purgeAfter: '2026-11-06T15:30:00Z' });
    expect(probe).toHaveBeenCalledWith(t);
  });

  it('本机会话已换成别人、sid 为 null：不查，unknown', async () => {
    const probe = vi.fn(async (): Promise<AccountProbe> => ({ kind: 'active' }));
    expect(await checkDeletion(db(tokenOf('s-2')), 's-1', { probe })).toEqual({ kind: 'unknown' });
    expect(await checkDeletion(db(tokenOf('s-1')), null, { probe })).toEqual({ kind: 'unknown' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('getSession 拿不到会话：本机存的会话也没了（刷新被拒、auth-js 已删并发 SIGNED_OUT）→ unsure；会话还在（断网刷新失败）→ unknown', async () => {
    const probe = vi.fn(async (): Promise<AccountProbe> => ({ kind: 'active' }));
    expect(await checkDeletion(db(null), 's-1', { probe, localSid: () => null })).toEqual({ kind: 'unsure' });
    expect(await checkDeletion(db(null), 's-1', { probe, localSid: () => 's-1' })).toEqual({ kind: 'unknown' });
    expect(await checkDeletion(db(null), 's-1', { probe, localSid: () => { throw new Error('storage'); } })).toEqual({ kind: 'unknown' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('getSession 卡住（刷新令牌不回）：到点按 unknown，不查 status（代码审查建议 2）', async () => {
    const probe = vi.fn(async (): Promise<AccountProbe> => ({ kind: 'active' }));
    const hang = async () => ({ auth: { getSession: () => new Promise(() => undefined) } }) as unknown as Db;
    expect(await checkDeletion(hang, 's-1', { probe, localSid: () => null, sessionTimeoutMs: 10 })).toEqual({ kind: 'unknown' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('取会话或探测抛错：unknown，不抛', async () => {
    const boom = async (): Promise<Db> => {
      throw new Error('boom');
    };
    expect(await checkDeletion(boom, 's-1')).toEqual({ kind: 'unknown' });
    expect(await checkDeletion(db(tokenOf('s-1')), 's-1', { probe: async () => Promise.reject(new Error('x')) })).toEqual({ kind: 'unknown' });
  });

  it('默认探测：经 functions.invoke 调 account {action: status}，带这次会话的令牌', async () => {
    const t = tokenOf('s-1');
    const invoke = vi.fn(async (_n: string, _o: unknown) => ({ data: { ok: true, status: 'active' }, error: null }));
    expect(await checkDeletion(db(t, invoke), 's-1')).toEqual({ kind: 'not_done' });
    expect(invoke).toHaveBeenCalledWith('account', { body: { action: 'status' }, headers: { Authorization: `Bearer ${t}` } });
  });

  it('默认探测：status 回 401 session_revoked / unauthorized → unsure', async () => {
    const t = tokenOf('s-1');
    for (const code of ['session_revoked', 'unauthorized']) {
      const ctx = new Response(JSON.stringify({ error: code }), { status: 401, headers: { 'content-type': 'application/json' } });
      const invoke = async () => ({ data: null, error: { name: 'FunctionsHttpError', context: ctx } });
      expect(await checkDeletion(db(t, invoke), 's-1'), code).toEqual({ kind: 'unsure' });
    }
  });
});
