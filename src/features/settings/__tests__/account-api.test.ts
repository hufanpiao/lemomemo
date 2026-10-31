// account 函数的调用（data/account-api.ts；架构第 6 节 account、错误码表；R-256 ②⑤；TC-B1-76、95 的客户端部分；0.47 起导出分片）
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { ACCOUNT_ERROR_CODES } from '../../../../shared/schema/account.ts';
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
    a: createAccountApi(getDb, { fetch: f as never, url: 'https://x.test/sb/functions/v1/account', anonKey: 'anon', readSid: () => 's-old', ...more }),
  };
}

const bodyOf = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body));

const EID = '9b2e4c6a-0000-4000-8000-0000000000aa';
const gz = (bytes: number[], next: string | null, more: Record<string, string> = {}): Response =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/gzip', ...(next === null ? {} : { 'x-lemo-export-next': next }), ...more },
  });

describe('startExport（0.47 续 ①）', () => {
  it('回 546（WORKER_LIMIT，正文没有 error）→ try_later，只发一次请求，不在这一层重发（TC-B1-126 ⑤、137 ①）', async () => {
    const { a, f } = api(async () => json(546, { code: 'WORKER_LIMIT', message: 'Function failed due to not having enough compute resources' }));
    expect(await a.startExport(null)).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('发 {action: export, step: start, device_id}，带这次会话的令牌和 apikey，不带隐私记令牌；回 export_id、exported_at 和这次的会话', async () => {
    const { a, f } = api(async () => json(200, { ok: true, export_id: EID, exported_at: '2026-10-30T15:30:00.123Z' }));
    expect(await a.startExport('3f0c1d2e-0000-4000-8000-000000000001')).toEqual({
      ok: true,
      value: { exportId: EID, exportedAt: '2026-10-30T15:30:00.123Z', sid: 's-1' },
    });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://x.test/sb/functions/v1/account');
    expect(init?.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ action: 'export', step: 'start', device_id: '3f0c1d2e-0000-4000-8000-000000000001' });
    const h = init?.headers as Record<string, string>;
    expect(h['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(h['apikey']).toBe('anon');
    expect(h['x-vault-token']).toBeUndefined();
  });

  it('本机没有设备行 id：不带 device_id；2xx 却没有 export_id 按 bad_response；没有 exported_at 时为 null', async () => {
    const one = api(async () => json(200, { ok: true, export_id: EID }));
    expect(await one.a.startExport(null)).toEqual({ ok: true, value: { exportId: EID, exportedAt: null, sid: 's-1' } });
    expect(bodyOf(one.f.mock.calls[0]?.[1])).toEqual({ action: 'export', step: 'start' });
    expect(await api(async () => json(200, { ok: true })).a.startExport(null)).toEqual({ ok: false, error: 'bad_response', sid: 's-1' });
    expect(await api(async () => new Response('x', { status: 200 })).a.startExport(null)).toEqual({ ok: false, error: 'bad_response', sid: 's-1' });
  });

  it('错误码：rate_limited、try_later、session_revoked、冷静期、停用、vault_locked、vault_relock（B5 才有，合成 vault_locked）；失败带这次请求的会话', async () => {
    const cases: Array<[number, unknown, string]> = [
      [429, { error: 'rate_limited' }, 'rate_limited'],
      [503, { error: 'try_later' }, 'try_later'],
      [401, { error: 'session_revoked' }, 'revoked'],
      [401, { error: 'unauthorized' }, 'revoked'],
      [403, { error: 'account_pending_deletion', purge_after: '2026-11-06T00:00:00Z' }, 'pending_deletion'],
      [403, { error: 'account_disabled' }, 'account_disabled'],
      [401, { error: 'vault_locked' }, 'vault_locked'],
      [401, { error: 'vault_relock' }, 'vault_locked'],
    ];
    for (const [status, body, want] of cases) {
      const { a } = api(async () => json(status, body));
      expect(await a.startExport(null), `${status} ${JSON.stringify(body)}`).toEqual({ ok: false, error: want, sid: 's-1' });
    }
  });

  it('fetch 本身失败算 offline；超时（20 秒，测试调小）算 try_later；本机没有会话算 signed_out（不发请求）', async () => {
    expect(await api(async () => Promise.reject(new TypeError('Failed to fetch'))).a.startExport(null)).toMatchObject({ error: 'offline' });
    const slow = api(
      (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      db(),
      { exportStartTimeoutMs: 5 },
    );
    expect(await slow.a.startExport(null)).toMatchObject({ error: 'try_later' });
    const none = api(async () => json(200, {}), db(null));
    expect(await none.a.startExport(null)).toEqual({ ok: false, error: 'signed_out', sid: null });
    expect(none.f).not.toHaveBeenCalled();
  });

  it('取会话出错（刷新令牌被拒）：算 revoked，带上调之前本机的会话', async () => {
    const { a } = api(async () => json(200, {}), db(null, { code: 'refresh_token_not_found', status: 400 }));
    expect(await a.startExport(null)).toEqual({ ok: false, error: 'revoked', sid: 's-old' });
  });
});

describe('takePart（0.47 续 ①）', () => {
  it('发 {action: export, step: part, export_id, cursor}；回这一片的字节原样（不解压）、下一个游标、content-disposition', async () => {
    const { a, f } = api(async () => gz([0x1f, 0x8b, 8, 0], 'eyJ0IjoxfQ', { 'content-disposition': 'attachment; filename=lemomemo-export-2026-10-30.json.gz' }));
    const r = await a.takePart(EID, null, 's-1');
    expect(bodyOf(f.mock.calls[0]?.[1])).toEqual({ action: 'export', step: 'part', export_id: EID, cursor: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Uint8Array(await r.value.blob.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 8, 0]));
    expect(r.value.next).toBe('eyJ0IjoxfQ');
    expect(r.value.disposition).toBe('attachment; filename=lemomemo-export-2026-10-30.json.gz');
    expect(r.value.contentLength).toBeNull();   // 替身响应没写 content-length 头；有头时见下一条（K3 用它核对收全了没有）
    await a.takePart(EID, 'eyJ0IjoxfQ', 's-1');
    expect(bodyOf(f.mock.calls[1]?.[1])).toEqual({ action: 'export', step: 'part', export_id: EID, cursor: 'eyJ0IjoxfQ' });
  });

  it('Content-Length 头：纯十进制非负整数才认，别的（含负数、带单位）都当没有（null）', async () => {
    for (const [h, want] of [['123', 123], ['0', 0], ['-1', null], ['12kb', null], ['', null]] as const) {
      const r = await api(async () => gz([0x1f, 0x8b], 'done', { 'content-length': h })).a.takePart(EID, 'c', 's-1');
      expect(r.ok && r.value.contentLength, h).toBe(want);
    }
  });

  it('游标头是 done：写完了（next 为 null）；没有游标头（跨域没暴露、接口对不上）或超过 512 字节：按 bad_response（分片停下、可以继续）', async () => {
    const done = await api(async () => gz([1], 'done')).a.takePart(EID, 'c', 's-1');
    expect(done.ok && done.value.next).toBe(null);
    expect(await api(async () => gz([1], null)).a.takePart(EID, 'c', 's-1')).toEqual({ ok: false, error: 'bad_response', sid: 's-1' });
    expect(await api(async () => gz([1], 'x'.repeat(513))).a.takePart(EID, 'c', 's-1')).toEqual({ ok: false, error: 'bad_response', sid: 's-1' });
    const edge = await api(async () => gz([1], 'x'.repeat(512))).a.takePart(EID, 'c', 's-1');
    expect(edge.ok).toBe(true);
  });

  it('明确的 4xx 码：400 bad_request、426 upgrade_required 是 unknown（不重试、不给继续，TC-B1-126 ④）；vault_* 是 vault_locked', async () => {
    expect(await api(async () => json(400, { error: 'bad_request' })).a.takePart(EID, 'c', 's-1')).toEqual({ ok: false, error: 'unknown', sid: 's-1' });
    expect(await api(async () => json(426, { error: 'upgrade_required' })).a.takePart(EID, 'c', 's-1')).toEqual({ ok: false, error: 'unknown', sid: 's-1' });
    expect(await api(async () => json(401, { error: 'vault_relock' })).a.takePart(EID, 'c', 's-1')).toEqual({ ok: false, error: 'vault_locked', sid: 's-1' });
  });

  it('新码：410 export_expired、413 export_too_large；429 rate_limited 原样（界面按“当天分片用完”）', async () => {
    for (const [status, code] of [[410, 'export_expired'], [413, 'export_too_large'], [429, 'rate_limited']] as const) {
      expect(await api(async () => json(status, { error: code })).a.takePart(EID, null, 's-1')).toEqual({ ok: false, error: code, sid: 's-1' });
    }
  });

  it('546（WORKER_LIMIT）、500、502、504 和读不出码的 5xx 都当 try_later（0.47 续 ③ 第 3 点）；4xx 读不出码仍是 unknown', async () => {
    for (const status of [546, 500, 502, 504, 503, 599]) {
      expect(await api(async () => new Response('<html>', { status })).a.takePart(EID, null, 's-1'), String(status)).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
    }
    expect(await api(async () => json(546, { code: 'WORKER_LIMIT', message: 'x' })).a.takePart(EID, null, 's-1')).toMatchObject({ error: 'try_later' });
    expect(await api(async () => new Response('x', { status: 400 })).a.takePart(EID, null, 's-1')).toMatchObject({ error: 'unknown' });
  });

  it('本机会话不是发起导出的那个（换过登录）：不发请求，直接 export_expired（任务绑定会话，0.47 第 15 条）', async () => {
    const { a, f } = api(async () => gz([1], 'done'));
    expect(await a.takePart(EID, 'c', 's-other')).toEqual({ ok: false, error: 'export_expired', sid: 's-1' });
    expect(f).not.toHaveBeenCalled();
  });

  it('每片 60 秒超时（测试调小）：响应头到了、包体读不完也按 try_later；包体读到一半断了按 offline', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array([0x1f])) });   // 不 close
    const s = api(async () => new Response(stalled, { status: 200, headers: { 'x-lemo-export-next': 'done' } }), db(), { exportPartTimeoutMs: 20 });
    expect(await s.a.takePart(EID, null, 's-1')).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
    const broken = new ReadableStream<Uint8Array>({ start: (c) => c.error(new TypeError('network error')) });
    const b = api(async () => new Response(broken, { status: 200, headers: { 'x-lemo-export-next': 'done' } }));
    expect(await b.a.takePart(EID, null, 's-1')).toEqual({ ok: false, error: 'offline', sid: 's-1' });
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

  describe('回 try_later 先查真实状态（0.47 第 22 条 T4）', () => {
    const busy = async () => json(503, { error: 'try_later' });

    it('已经办成（冷静期、会话已被吊销）：按成功，带回 purge_after（查不到为 null）和这次的会话', async () => {
      const check = vi.fn(async (_sid: string | null) => ({ kind: 'done' as const, purgeAfter: '2026-11-06T15:30:00Z' }));
      const { a } = api(busy, db(), { checkDeletion: check });
      expect(await a.requestDeletion('注销')).toEqual({ ok: true, value: { purgeAfter: '2026-11-06T15:30:00Z', sid: 's-1' } });
      expect(check).toHaveBeenCalledWith('s-1');
      const { a: b } = api(busy, db(), { checkDeletion: async () => ({ kind: 'done' as const, purgeAfter: null }) });
      expect(await b.requestDeletion('注销')).toEqual({ ok: true, value: { purgeAfter: null, sid: 's-1' } });
    });

    it('确认不了（status 只查到会话已失效，H1）：按离开处理但带 unsure，离开时提示 deletion_unsure', async () => {
      const { a } = api(busy, db(), { checkDeletion: async () => ({ kind: 'unsure' as const }) });
      expect(await a.requestDeletion('注销')).toEqual({ ok: true, value: { purgeAfter: null, sid: 's-1', unsure: true } });
    });

    it('没办成、判断不了：照旧 try_later；停用：account_disabled', async () => {
      for (const kind of ['not_done', 'unknown'] as const) {
        const { a } = api(busy, db(), { checkDeletion: async () => ({ kind }) });
        expect(await a.requestDeletion('注销'), kind).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
      }
      const { a } = api(busy, db(), { checkDeletion: async () => ({ kind: 'disabled' as const }) });
      expect(await a.requestDeletion('注销')).toEqual({ ok: false, error: 'account_disabled', sid: 's-1' });
    });

    it('超时（到点按 try_later）同样先查', async () => {
      const check = vi.fn(async () => ({ kind: 'done' as const, purgeAfter: null }));
      const hang = (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      const { a } = api(hang, db(), { deleteTimeoutMs: 20, checkDeletion: check });
      expect(await a.requestDeletion('注销')).toEqual({ ok: true, value: { purgeAfter: null, sid: 's-1' } });
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('别的失败（rate_limited、offline 等）不查', async () => {
      const check = vi.fn(async () => ({ kind: 'done' as const, purgeAfter: null }));
      const { a } = api(async () => json(429, { error: 'rate_limited' }), db(), { checkDeletion: check });
      expect(await a.requestDeletion('注销')).toEqual({ ok: false, error: 'rate_limited', sid: 's-1' });
      expect(check).not.toHaveBeenCalled();
    });

    it('默认核对：db 没有 functions（查不了）时按判断不了，照旧 try_later', async () => {
      const { a } = api(busy);
      expect(await a.requestDeletion('注销')).toEqual({ ok: false, error: 'try_later', sid: 's-1' });
    });
  });
});

describe('misconfigured（入口配置错误，500，不在共享码表；10-31 代码审查建议）', () => {
  it('映射成 unknown（显示“出错”），不按 500 当稍后再试', () => {
    expect(mapAccountCode('misconfigured', 500)).toBe('unknown');
    expect(mapAccountCode(null, 500)).toBe('try_later');
  });

  it('注销收到它：回 unknown，不去查状态', async () => {
    const check = vi.fn(async () => ({ kind: 'done' as const, purgeAfter: null }));
    const { a } = api(async () => json(500, { error: 'misconfigured' }), db(), { checkDeletion: check });
    expect(await a.requestDeletion('注销')).toEqual({ ok: false, error: 'unknown', sid: 's-1' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('辅助', () => {
  it('和共享的 ACCOUNT_ERROR_CODES（13 个）逐个对齐：每个码都有去处，restore 才有的三个是 unknown', () => {
    const want: Record<(typeof ACCOUNT_ERROR_CODES)[number], string> = {
      confirm_required: 'confirm_required',
      admin_cannot_delete: 'admin_cannot_delete',
      rate_limited: 'rate_limited',
      reauth_required: 'unknown',
      not_pending: 'unknown',
      restore_too_late: 'unknown',
      account_disabled: 'account_disabled',
      account_pending_deletion: 'pending_deletion',
      vault_locked: 'vault_locked',
      vault_relock: 'vault_locked',
      try_later: 'try_later',
      export_expired: 'export_expired',
      export_too_large: 'export_too_large',
    };
    expect(ACCOUNT_ERROR_CODES).toHaveLength(13);
    for (const code of ACCOUNT_ERROR_CODES) expect(mapAccountCode(code, 400), code).toBe(want[code]);
  });

  it('mapAccountCode：没有码时按状态（5xx 含 546 → try_later、401 → revoked）；分片的两个新码；原型上的名字不算码', () => {
    expect(mapAccountCode(null, 503)).toBe('try_later');
    expect(mapAccountCode(null, 546)).toBe('try_later');
    expect(mapAccountCode('export_expired', 410)).toBe('export_expired');
    expect(mapAccountCode('export_too_large', 413)).toBe('export_too_large');
    expect(mapAccountCode('toString', 400)).toBe('unknown');
    expect(mapAccountCode(undefined, 401)).toBe('revoked');
    expect(mapAccountCode('not_pending', 409)).toBe('unknown');
  });

  it('exportFileName：只认 lemomemo-export-<日期>.json.gz 这一种，别的（含路径、引号注入）一律按 UTC 日期拼', () => {
    expect(exportFileName('attachment; filename="lemomemo-export-2026-10-29.json.gz"', NOW)).toBe('lemomemo-export-2026-10-29.json.gz');
    expect(exportFileName('attachment; filename="../evil.exe"', NOW)).toBe('lemomemo-export-2026-10-30.json.gz');
    expect(exportFileName(null, Date.parse('2026-10-30T23:59:59+09:00'))).toBe('lemomemo-export-2026-10-30.json.gz');
  });
});
