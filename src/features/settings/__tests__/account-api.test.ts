// account 函数的调用（data/account-api.ts；架构第 6 节 account、错误码表；R-256 ②⑤；TC-B1-76、95 的客户端部分）
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createAccountApi, exportFileName, mapAccountCode } from '../data/account-api.ts';

const b64 = (o: unknown): string => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', session_id: 's-1' })}.sig`;
const NOW = Date.parse('2026-10-30T15:30:00Z');

function db(session: unknown = { access_token: TOKEN, user: { id: 'u1' } }, error: unknown = null): () => Promise<Db> {
  return async () => ({ auth: { getSession: async () => ({ data: { session }, error }) } }) as unknown as Db;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(fetch: (url: string, init: RequestInit) => Promise<Response>, getDb = db(), more = {}) {
  const f = vi.fn(fetch);
  return {
    f,
    a: createAccountApi(getDb, { fetch: f as never, url: 'https://x.test/sb/functions/v1/account', anonKey: 'anon', readSid: () => 's-old', now: () => NOW, ...more }),
  };
}

const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body));

describe('exportAll', () => {
  it('带 device_id、这次会话的令牌和 apikey；回 gzip 存成 lemomemo-export-<UTC 日期>.json.gz，文件名取 content-disposition；B1 一律标“隐私记没导出”', async () => {
    const { a, f } = api(async () =>
      new Response(new Uint8Array([0x1f, 0x8b, 1, 2]), {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="lemomemo-export-2026-10-29.json.gz"' },
      }),
    );
    const r = await a.exportAll('3f0c1d2e-0000-4000-8000-000000000001');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe('lemomemo-export-2026-10-29.json.gz');
    expect(r.value.vaultOmitted).toBe(true);
    expect(r.value.blob.type).toBe('application/gzip');
    expect(new Uint8Array(await r.value.blob.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 1, 2]));
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://x.test/sb/functions/v1/account');
    expect(init?.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ action: 'export', device_id: '3f0c1d2e-0000-4000-8000-000000000001' });
    const h = init?.headers as Record<string, string>;
    expect(h['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(h['apikey']).toBe('anon');
    // B1 不带隐私记令牌
    expect(h['x-vault-token']).toBeUndefined();
  });

  it('本机没有设备行 id：不带 device_id；读不到 content-disposition（跨域没暴露）时按 UTC 日期拼文件名', async () => {
    const { a, f } = api(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'application/gzip' } }));
    const r = await a.exportAll(null);
    expect(bodyOf(f.mock.calls[0]?.[1])).toEqual({ action: 'export' });
    expect(r.ok && r.value.name).toBe('lemomemo-export-2026-10-30.json.gz');
  });

  it('错误码：429 rate_limited、503 try_later、session_revoked、冷静期、停用、vault_locked（B5 才有，先当 unknown）；失败带这次请求的会话', async () => {
    const cases: Array<[number, unknown, string]> = [
      [429, { error: 'rate_limited' }, 'rate_limited'],
      [503, { error: 'try_later' }, 'try_later'],
      [401, { error: 'session_revoked' }, 'revoked'],
      [401, { error: 'unauthorized' }, 'revoked'],
      [403, { error: 'account_pending_deletion', purge_after: '2026-11-06T00:00:00Z' }, 'pending_deletion'],
      [403, { error: 'account_disabled' }, 'account_disabled'],
      [401, { error: 'vault_locked' }, 'unknown'],
      [401, { error: 'vault_relock' }, 'unknown'],
      [502, 'not json', 'unknown'],
    ];
    for (const [status, body, want] of cases) {
      const { a } = api(async () => json(status, body));
      expect(await a.exportAll(null), `${status} ${JSON.stringify(body)}`).toEqual({ ok: false, error: want, sid: 's-1' });
    }
  });

  it('fetch 本身失败算 offline；超时算 try_later；本机没有会话算 signed_out（不发请求）', async () => {
    expect(await api(async () => Promise.reject(new TypeError('Failed to fetch'))).a.exportAll(null)).toMatchObject({ error: 'offline' });
    const slow = api(
      (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      db(),
      { exportTimeoutMs: 5 },
    );
    expect(await slow.a.exportAll(null)).toMatchObject({ error: 'try_later' });
    const none = api(async () => json(200, {}), db(null));
    expect(await none.a.exportAll(null)).toEqual({ ok: false, error: 'signed_out', sid: null });
    expect(none.f).not.toHaveBeenCalled();
  });

  it('拿到 200 的响应头以后包体读不完（断流又不断开）：超时按 try_later 返回，不一直挂着', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array([0x1f])) });   // 不 close
    const { a } = api(async () => new Response(stalled, { status: 200, headers: { 'content-type': 'application/gzip' } }), db(), { exportTimeoutMs: 20 });
    expect(await a.exportAll(null)).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
  });

  it('包体读到一半出错（不是超时）：按 offline', async () => {
    const broken = new ReadableStream<Uint8Array>({ start: (c) => c.error(new TypeError('network error')) });
    const { a } = api(async () => new Response(broken, { status: 200 }));
    expect(await a.exportAll(null)).toEqual({ ok: false, error: 'offline', sid: 's-1' });
  });

  it('取会话出错（刷新令牌被拒）：算 revoked，带上调之前本机的会话', async () => {
    const { a } = api(async () => json(200, {}), db(null, { code: 'refresh_token_not_found', status: 400 }));
    expect(await a.exportAll(null)).toEqual({ ok: false, error: 'revoked', sid: 's-old' });
  });
});

describe('requestDeletion', () => {
  it('发 {action: delete, confirm}；成功带回 purge_after 和这次请求用的会话', async () => {
    const { a, f } = api(async () => json(200, { ok: true, purge_after: '2026-11-06T15:30:00Z' }));
    expect(await a.requestDeletion('注销')).toEqual({ ok: true, value: { purgeAfter: '2026-11-06T15:30:00Z', sid: 's-1' } });
    expect(bodyOf(f.mock.calls[0]?.[1])).toEqual({ action: 'delete', confirm: '注销' });
  });

  it('confirm_required、admin_cannot_delete、rate_limited 原样认出', async () => {
    for (const code of ['confirm_required', 'admin_cannot_delete', 'rate_limited'] as const) {
      const { a } = api(async () => json(code === 'rate_limited' ? 429 : code === 'admin_cannot_delete' ? 403 : 400, { error: code }));
      expect(await a.requestDeletion('注销')).toEqual({ ok: false, error: code, sid: 's-1' });
    }
  });
});

describe('辅助', () => {
  it('mapAccountCode：没有码时按状态（503 → try_later、401 → revoked）', () => {
    expect(mapAccountCode(null, 503)).toBe('try_later');
    expect(mapAccountCode(undefined, 401)).toBe('revoked');
    expect(mapAccountCode('not_pending', 409)).toBe('unknown');
  });

  it('exportFileName：只认 lemomemo-export-<日期>.json.gz 这一种，别的（含路径、引号注入）一律按 UTC 日期拼', () => {
    expect(exportFileName('attachment; filename="lemomemo-export-2026-10-29.json.gz"', NOW)).toBe('lemomemo-export-2026-10-29.json.gz');
    expect(exportFileName('attachment; filename="../evil.exe"', NOW)).toBe('lemomemo-export-2026-10-30.json.gz');
    expect(exportFileName(null, Date.parse('2026-10-30T23:59:59+09:00'))).toBe('lemomemo-export-2026-10-30.json.gz');
  });
});
