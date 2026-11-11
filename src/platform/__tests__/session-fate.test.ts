// R-382（架构 4.1a 第 1、4 点）：session_fate 只发本机算的哈希，只认 revoked / unknown，其余一律“查不了”
import { describe, expect, it, vi } from 'vitest';
import { pairHash } from '../auth-loss-log.ts';
import { querySessionFate, querySessionFateResult } from '../supabase/session-fate.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';
const d = (f: unknown) => ({ fetch: f as typeof fetch, url: 'https://x.supabase.co/', anonKey: 'anon', online: () => true });
const reply = (status: number, body: unknown) => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('querySessionFate', () => {
  it('POST /rest/v1/rpc/session_fate，请求体只有 p_pair（哈希），不含明文 uuid', async () => {
    const f = reply(200, 'revoked');
    expect(await querySessionFate(S, A, d(f))).toBe('revoked');
    const call = f.mock.calls[0];
    if (!call) throw new Error('没发请求');
    const [url, init] = call;
    expect(url).toBe('https://x.supabase.co/rest/v1/rpc/session_fate');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ p_pair: await pairHash(S, A) }));
    expect(String(init?.body)).not.toContain(S);
    expect(String(init?.body)).not.toContain(A);
  });

  it('unknown 原样回；别的词、非 2xx、抛错、离线、没配置、uuid 不合法都回 null', async () => {
    expect(await querySessionFate(S, A, d(reply(200, 'unknown')))).toBe('unknown');
    expect(await querySessionFate(S, A, d(reply(200, 'gone')))).toBeNull();
    for (const s of [404, 426, 429, 500]) expect(await querySessionFate(S, A, d(reply(s, 'revoked')))).toBeNull();
    // 登录页的退避重查只认 429、5xx（安全审建议 1）；别的查不了仍是 null
    for (const s of [429, 500, 502, 503]) expect(await querySessionFateResult(S, A, d(reply(s, 'revoked')))).toBe('retry');
    for (const s of [404, 426, 400]) expect(await querySessionFateResult(S, A, d(reply(s, 'revoked')))).toBeNull();
    expect(await querySessionFateResult(S, A, d(reply(200, 'revoked')))).toBe('revoked');
    const thrower = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await querySessionFate(S, A, d(thrower))).toBeNull();
    const f = reply(200, 'revoked');
    expect(await querySessionFate(S, A, { ...d(f), online: () => false })).toBeNull();
    expect(await querySessionFate(S, A, { ...d(f), url: '' })).toBeNull();
    expect(await querySessionFate('bad', A, d(f))).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('超时回 null', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort')))));
    expect(await querySessionFate(S, A, { ...d(f), timeoutMs: 10 })).toBeNull();
  });
});
