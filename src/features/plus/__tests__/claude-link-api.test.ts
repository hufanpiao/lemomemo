// 设置 › 在 Claude 聊天里记事（FA-4）：连着没有、最后使用、生成连接码、断开连接
import { describe, expect, it, vi } from 'vitest';
import { CODE_TTL_DAYS, createLink, createVia, disconnectAll, linkStateOf, listLinks, type LinkDeps, type LinkRow } from '../data/claude-link-api.ts';

const NOW = Date.parse('2026-11-09T03:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const row = (o: Partial<LinkRow> = {}): LinkRow => ({ id: 'a', created_at: iso(NOW - DAY), last_used_at: null, revoked_at: null, ...o });

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const deps = (over: Partial<LinkDeps> = {}): LinkDeps => ({
  list: async () => ({ data: [], error: null }),
  revokeAll: async () => ({ error: null }),
  create: async () => json(200, { token: 'lemo_abc', id: 'x', expires_at: '2027-05-08T00:00:00Z' }),
  online: () => true,
  ...over,
});

describe('linkStateOf', () => {
  it('没有码 → 没连接', () => expect(linkStateOf([], NOW)).toEqual({ connected: false, lastUsedMs: null, madeMs: null }));

  it('取有效码里最晚的使用时间', () => {
    const rows = [
      row({ id: '1', last_used_at: iso(NOW - 3 * DAY) }),
      row({ id: '2', last_used_at: iso(NOW - DAY) }),
      row({ id: '3', last_used_at: null, created_at: iso(NOW - 2000) }),
    ];
    // 连接日期取有效码里最晚建的那个（线框 s13“· 10/24 连接”）
    expect(linkStateOf(rows, NOW)).toEqual({ connected: true, lastUsedMs: NOW - DAY, madeMs: NOW - 2000 });
  });

  it('已吊销、过期（满 180 天）的码不算，它们的使用时间也不算', () => {
    const rows = [
      row({ id: '1', revoked_at: iso(NOW - DAY), last_used_at: iso(NOW - 1000) }),
      row({ id: '2', created_at: iso(NOW - CODE_TTL_DAYS * DAY), last_used_at: iso(NOW - 2000) }),
    ];
    expect(linkStateOf(rows, NOW)).toEqual({ connected: false, lastUsedMs: null, madeMs: null });
  });

  it('179 天的还有效；时间读不出来的行不算', () => {
    expect(linkStateOf([row({ created_at: iso(NOW - 179 * DAY) })], NOW).connected).toBe(true);
    expect(linkStateOf([row({ created_at: 'garbage' })], NOW).connected).toBe(false);
  });
});

describe('listLinks', () => {
  it('滤掉结构不对的行', async () => {
    const data = [row(), { id: 1 }, null, row({ id: 'b' })];
    const r = await listLinks(deps({ list: async () => ({ data, error: null }) }));
    expect(r.ok && r.value.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('出错 → failed；离线不发', async () => {
    expect(await listLinks(deps({ list: async () => ({ data: null, error: { message: 'x' } }) }))).toEqual({ ok: false, err: 'failed' });
    const list = vi.fn();
    expect(await listLinks(deps({ online: () => false, list }))).toEqual({ ok: false, err: 'offline' });
    expect(list).not.toHaveBeenCalled();
  });
});

describe('createLink', () => {
  it('成功 → 明文码和过期时间', async () => {
    expect(await createLink(deps())).toEqual({ ok: true, value: { token: 'lemo_abc', expiresAt: '2027-05-08T00:00:00Z' } });
  });

  it.each([
    [409, 'too_many'],
    [429, 'rate_limited'],
    [500, 'failed'],
    [426, 'failed'],
  ] as const)('%i → %s', async (status, err) => {
    expect(await createLink(deps({ create: async () => json(status, { error: 'x' }) }))).toEqual({ ok: false, err });
  });

  it('没登录 → signed_out；回的没有码 → failed；网络错 → offline', async () => {
    expect(await createLink(deps({ create: async () => null }))).toEqual({ ok: false, err: 'signed_out' });
    expect(await createLink(deps({ create: async () => json(200, { token: '' }) }))).toEqual({ ok: false, err: 'failed' });
    expect(await createLink(deps({ create: async () => new Response('not json', { status: 200 }) }))).toEqual({ ok: false, err: 'failed' });
    const create = async (): Promise<never> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await createLink(deps({ create }))).toEqual({ ok: false, err: 'offline' });
  });
});

describe('生成连接码的请求走 fn-post 的 sendFn（令牌 POST 只有那一个出口）', () => {
  const via = (res: (n: number) => Response, token: string | null = 'jwt-1', refresh: string | null = null) => {
    let n = 0;
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => res(++n));
    const create = createVia({ fetch, url: 'https://sb.test/functions/v1/token-admin', anonKey: 'anon-1', token: async () => token, refresh: async () => refresh });
    return { fetch, d: deps({ create }) };
  };

  it('POST token-admin：带令牌、apikey、no-store，包体 {action: create}', async () => {
    const { fetch, d } = via(() => json(200, { token: 'lemo_abc' }));
    expect(await createLink(d)).toMatchObject({ ok: true, value: { token: 'lemo_abc' } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://sb.test/functions/v1/token-admin');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', body: JSON.stringify({ action: 'create' }) });
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt-1', apikey: 'anon-1', 'content-type': 'application/json' });
  });

  it('409、429 原样交给 createLink 归类；没登录不发', async () => {
    expect(await createLink(via(() => json(409, {})).d)).toEqual({ ok: false, err: 'too_many' });
    expect(await createLink(via(() => json(429, {})).d)).toEqual({ ok: false, err: 'rate_limited' });
    const out = via(() => json(200, { token: 'x' }), null);
    expect(await createLink(out.d)).toEqual({ ok: false, err: 'signed_out' });
    expect(out.fetch).not.toHaveBeenCalled();
  });

  it('401：换一次令牌再发', async () => {
    const { fetch, d } = via((n) => (n === 1 ? json(401, {}) : json(200, { token: 'lemo_abc' })), 'jwt-1', 'jwt-2');
    expect(await createLink(d)).toMatchObject({ ok: true });
    expect(fetch.mock.calls.map((c) => (c[1]?.headers as Record<string, string>)['authorization'])).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
  });
});

describe('disconnectAll', () => {
  it('成功 / 失败', async () => {
    expect(await disconnectAll(deps())).toEqual({ ok: true, value: null });
    expect(await disconnectAll(deps({ revokeAll: async () => ({ error: { message: 'x' } }) }))).toEqual({ ok: false, err: 'failed' });
  });
});
