// 设置 › 在 Claude 聊天里记事（FA-4）：连着没有、最后使用、生成连接码、断开连接
import { describe, expect, it, vi } from 'vitest';
import { CODE_TTL_DAYS, createLink, disconnectAll, linkStateOf, listLinks, type LinkDeps, type LinkRow } from '../data/claude-link-api.ts';

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

describe('disconnectAll', () => {
  it('成功 / 失败', async () => {
    expect(await disconnectAll(deps())).toEqual({ ok: true, value: null });
    expect(await disconnectAll(deps({ revokeAll: async () => ({ error: { message: 'x' } }) }))).toEqual({ ok: false, err: 'failed' });
  });
});
