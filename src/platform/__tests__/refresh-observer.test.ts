// R-382（架构 4.1a 第 1 点 ①、第 6、7 点）：刷新令牌观察只认那一个地址，只记码，不读请求体、不改回包。
// 升级 supabase-js 时必须过这一组
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_FAILURE_WINDOW_MS, isRefreshRequest, observeRefresh, recentRefreshFailure, resetRefreshObserverForTest, setRefreshSessionReader,
} from '../supabase/refresh-observer.ts';

const URL_ = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token';
const T = 1_800_000_000_000;
const now = (): number => T;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failWith = (res: Response) => observeRefresh(vi.fn(async () => res), now);

afterEach(() => resetRefreshObserverForTest());

describe('isRefreshRequest', () => {
  it('只认 POST …/auth/v1/token?grant_type=refresh_token', () => {
    expect(isRefreshRequest(URL_, { method: 'POST' })).toBe(true);
    expect(isRefreshRequest(new URL(URL_), { method: 'post' })).toBe(true);
    expect(isRefreshRequest(new Request(URL_, { method: 'POST' }))).toBe(true);
    expect(isRefreshRequest(URL_)).toBe(false);
    expect(isRefreshRequest('https://x.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' })).toBe(false);
    expect(isRefreshRequest('https://x.supabase.co/auth/v1/user', { method: 'POST' })).toBe(false);
    expect(isRefreshRequest('https://x.supabase.co/rest/v1/rpc/token?grant_type=refresh_token', { method: 'POST' })).toBe(false);
  });
});

describe('observeRefresh', () => {
  it('非 2xx：记 error_code、状态、时刻、本机 sid；交回的是同一个 Response、正文还能读', async () => {
    setRefreshSessionReader(() => 'sid-local');
    const res = json(400, { error_code: 'refresh_token_already_used', code: 400, msg: 'Invalid Refresh Token' });
    const got = await failWith(res)(URL_, { method: 'POST', body: 'grant=secret' });
    expect(got).toBe(res);
    expect(await got.json()).toMatchObject({ error_code: 'refresh_token_already_used' });
    expect(recentRefreshFailure(T)).toEqual({ code: 'refresh_token_already_used', status: 400, at: T, sid: 'sid-local' });
  });

  it('没有 error_code 读 code；码不合白名单或不是 JSON 记 unparsable', async () => {
    await failWith(json(403, { code: 'session_not_found' }))(URL_, { method: 'POST' });
    expect(recentRefreshFailure(T)?.code).toBe('session_not_found');
    await failWith(json(400, { error_code: 'Bearer eyJ.x' }))(URL_, { method: 'POST' });
    expect(recentRefreshFailure(T)?.code).toBe('unparsable');
    await failWith(new Response('<html>502</html>', { status: 502 }))(URL_, { method: 'POST' });
    expect(recentRefreshFailure(T)).toMatchObject({ code: 'unparsable', status: 502 });
  });

  it('断网：记 network（状态 0），错误原样抛出', async () => {
    const err = new TypeError('Failed to fetch');
    const f = observeRefresh(vi.fn(async () => {
      throw err;
    }), now);
    await expect(f(URL_, { method: 'POST' })).rejects.toBe(err);
    expect(recentRefreshFailure(T)).toMatchObject({ code: 'network', status: 0 });
  });

  it('2xx：清掉记录、回包一个字节也不读', async () => {
    await failWith(json(400, { error_code: 'x' }))(URL_, { method: 'POST' });
    const ok = json(200, { access_token: 'tok' });
    const clone = vi.spyOn(ok, 'clone');
    const read = vi.spyOn(ok, 'json');
    expect(await failWith(ok)(URL_, { method: 'POST' })).toBe(ok);
    expect(clone).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(ok.bodyUsed).toBe(false);
    expect(recentRefreshFailure(T)).toBeNull();
  });

  it('别的请求原样放过、不记；请求体不读', async () => {
    const res = json(401, { error_code: 'bad_jwt' });
    expect(await failWith(res)('https://x.supabase.co/rest/v1/notes', { method: 'POST' })).toBe(res);
    expect(res.bodyUsed).toBe(false);
    expect(recentRefreshFailure(T)).toBeNull();
    const req = new Request(URL_, { method: 'POST', body: 'refresh_token=r1' });
    await failWith(json(400, { error_code: 'x' }))(req);
    expect(req.bodyUsed).toBe(false);
  });

  it('只认 120 秒以内的那条', async () => {
    await failWith(json(400, { error_code: 'x' }))(URL_, { method: 'POST' });
    expect(recentRefreshFailure(T + REFRESH_FAILURE_WINDOW_MS)).not.toBeNull();
    expect(recentRefreshFailure(T + REFRESH_FAILURE_WINDOW_MS + 1)).toBeNull();
  });

  it('sid 取本机会话（不从请求、回包里取）；读不了是 null', async () => {
    setRefreshSessionReader(() => {
      throw new Error('x');
    });
    await failWith(json(403, { error_code: 'session_not_found', session_id: 'from-body' }))(URL_, { method: 'POST' });
    expect(recentRefreshFailure(T)?.sid).toBeNull();
  });
});
