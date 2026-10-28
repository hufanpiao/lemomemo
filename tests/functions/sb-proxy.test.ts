// `/sb/*` 转发的单元测试（14.2 第 1～10 点；TC-B0-39、TC-B0-46、TC-B0-59 的转发层部分、TC-B0-91 的转发层部分）。
// 上游用桩：记录收到的请求，不连真实 Supabase。经预览环境的真实转发见 tests/e2e/sb-forward.preview.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { STRIPPED_REQUEST_HEADERS, geoHeader, handleSb, upstreamPath, type SbEnv } from '../../functions/sb/[[path]].ts';
import { createVersionGate } from '../../functions/sb/version-gate.ts';
import { ALLOW_HEADERS, EXE_ORIGIN } from '../../functions/_lib/cors.ts';

const ENV: SbEnv = {
  SUPABASE_UPSTREAM: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test',
  PROXY_SECRET: 'proxy-secret-test',
};

function setup(opts: { min?: string; upstream?: (req: Request) => Promise<Response> } = {}) {
  const seen: Request[] = [];
  const log = vi.fn();
  const fetchStub = vi.fn(async (req: Request) => {
    seen.push(req);
    if (opts.upstream) return opts.upstream(req);
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Content-Range': '0-0/1',
        'Set-Cookie': '__cf_bm=x; Domain=.supabase.co',
      },
    });
  });
  const gate = createVersionGate({ loadMin: async () => opts.min ?? '4.0.0' });
  /** 上游收到的第一个请求；没收到就让用例失败（不用非空断言） */
  const first = (): Request => {
    const r = seen[0];
    if (!r) throw new Error('上游没有收到请求');
    return r;
  };
  return { seen, first, log, fetchStub, deps: { fetch: fetchStub, gate, log } };
}

const BASE = 'https://lemomemo.com';

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(BASE + path, { ...init, headers: { 'X-App-Version': '4.0.0', ...(init.headers ?? {}) } });
}

describe('upstreamPath：路径白名单和穿越', () => {
  it.each([
    ['/sb/rest/v1/todos', '/rest/v1/todos'],
    ['/sb/rest/v1/todos?select=*&id=eq.1', '/rest/v1/todos'],
    ['/sb/auth/v1/otp', '/auth/v1/otp'],
    ['/sb/storage/v1/object/sign/images/a%20b.webp', '/storage/v1/object/sign/images/a%20b.webp'],
    ['/sb/functions/v1/ai-parse', '/functions/v1/ai-parse'],
    ['/sb/realtime/v1/websocket?apikey=x&vsn=1.0.0', '/realtime/v1/websocket'],
  ])('%s → %s', (p, want) => {
    expect(upstreamPath(BASE + p)).toBe(want);
  });

  it.each([
    '/sb/graphql/v1',
    '/sb/pg/query',
    '/sb/rest/v1/',
    '/sb/auth/v1/admin/users',
    '/sb/%2e%2e/graphql/v1',
    '/sb/%2E%2E/graphql/v1',
    '/sb//evil.example/x',
    '/sb/rest/v1/../auth/v1/admin',
    '/sb/rest/v1/./todos',
    '/sb/rest/v1/todos%2f..%2fadmin',
    '/sb/rest/v1/todos%5cx',
    '/sb/rest/v1/todos%00',
    '/sb/rest/v1\\todos',
    '/sb',
    '/sb/',
    '/sbx/rest/v1/todos',
    '/rest/v1/todos',
    '/sb/rest/v1/to"dos',
  ])('%s → 拒绝', (p) => {
    expect(upstreamPath(BASE + p)).toBeNull();
  });
});

describe('handleSb：白名单外、穿越', () => {
  it.each(['/sb/graphql/v1', '/sb/%2e%2e/graphql/v1', '/sb//evil.example/x', '/sb/rest/v1/../auth/v1/admin'])(
    'TC-B0-39：%s → 404，不请求上游',
    async (p) => {
      const s = setup();
      // 注意：Request 会先把 `..`、`%2e%2e` 规整掉（Cloudflare 入口同样会），规整后也必须落在白名单外
      const r = await handleSb(new Request(BASE + p), ENV, s.deps);
      expect(r.status).toBe(404);
      expect(s.fetchStub).not.toHaveBeenCalled();
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    },
  );

  it('上游地址按 SUPABASE_UPSTREAM 拼，主机不变、查询串原样', async () => {
    const s = setup();
    await handleSb(req('/sb/rest/v1/todos?select=id,title&id=eq.1'), ENV, s.deps);
    const u = new URL(s.first().url);
    expect(u.origin).toBe(ENV.SUPABASE_UPSTREAM);
    expect(u.pathname).toBe('/rest/v1/todos');
    expect(u.search).toBe('?select=id,title&id=eq.1');
  });

  it('TRACE 等方法回 405', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos', { method: 'PROPFIND' }), ENV, s.deps);
    expect(r.status).toBe(405);
  });
});

describe('请求头重写（14.2 第 4、5 点；TC-B0-91 转发层部分）', () => {
  it('伪造的 IP、secret、geo、region 先删后写', async () => {
    const s = setup();
    await handleSb(
      req('/sb/rest/v1/todos', {
        headers: {
          'x-client-ip': '6.6.6.6',
          'x-forwarded-for': '6.6.6.6',
          'x-real-ip': '6.6.6.6',
          'x-proxy-secret': 'guess',
          'x-lemo-geo': 'KR|Seoul',
          'x-region': 'us-east-1',
          'true-client-ip': '6.6.6.6',
          'CF-Connecting-IP': '203.0.113.9',
          Cookie: 'lemo_lang=ko',
          Authorization: 'Bearer user-jwt',
          apikey: 'anon',
        },
      }),
      ENV,
      s.deps,
      { country: 'CN', city: '上海' },
    );
    const h = s.first().headers;
    expect(h.get('x-client-ip')).toBe('203.0.113.9');
    expect(h.get('x-proxy-secret')).toBe(ENV.PROXY_SECRET);
    expect(h.get('x-lemo-geo')).toBe('CN|' + encodeURIComponent('上海'));
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('x-real-ip')).toBeNull();
    expect(h.get('true-client-ip')).toBeNull();
    expect(h.get('x-region')).toBeNull(); // 只有函数才带
    expect(h.get('cookie')).toBeNull();
    expect(h.get('authorization')).toBe('Bearer user-jwt');
    expect(h.get('apikey')).toBe('anon');
  });

  it('没有 CF-Connecting-IP 时不写 x-client-ip（客户端传的照样删掉）', async () => {
    const s = setup();
    await handleSb(req('/sb/rest/v1/todos', { headers: { 'x-client-ip': '6.6.6.6' } }), ENV, s.deps);
    expect(s.first().headers.get('x-client-ip')).toBeNull();
  });

  it('函数固定首尔：x-region = ap-northeast-2，覆盖客户端传的', async () => {
    const s = setup();
    await handleSb(req('/sb/functions/v1/ai-parse', { method: 'POST', body: '{}', headers: { 'x-region': 'us-east-1' } }), ENV, s.deps);
    expect(s.first().headers.get('x-region')).toBe('ap-northeast-2');
  });

  it('方法和请求体原样转发', async () => {
    const s = setup();
    await handleSb(req('/sb/rest/v1/todos', { method: 'PATCH', body: '{"title":"x"}', headers: { 'Content-Type': 'application/json' } }), ENV, s.deps);
    expect(s.first().method).toBe('PATCH');
    expect(await s.first().text()).toBe('{"title":"x"}');
  });

  it('删除名单覆盖架构列出的几个头', () => {
    for (const n of ['x-client-ip', 'x-proxy-secret', 'x-forwarded-for', 'x-real-ip', 'x-lemo-geo']) {
      expect(STRIPPED_REQUEST_HEADERS).toContain(n);
    }
  });

  it('geoHeader：格式和兜底', () => {
    expect(geoHeader({ country: 'KR', city: 'Seoul' })).toBe('KR|Seoul');
    expect(geoHeader(undefined)).toBe('-|-');
    expect(geoHeader({ country: 'kr; drop', city: '' })).toBe('-|-');
  });
});

describe('响应头：安全头和 CORS（5.10、15.6；TC-B0-59 的 /sb/ 部分）', () => {
  it('同源请求：加 nosniff 和 sandbox CSP，删掉上游的 Access-Control-* 和 Set-Cookie，Content-Type 不变', async () => {
    const s = setup();
    const r = await handleSb(req('/sb/rest/v1/todos'), ENV, s.deps);
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(r.headers.get('Content-Type')).toBe('application/json');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(r.headers.get('Set-Cookie')).toBeNull();
    expect(r.headers.get('Vary')).toContain('Origin');
  });

  it('exe 来源：只回 exe 的来源，暴露 Date、Content-Range', async () => {
    const s = setup();
    const r = await handleSb(req('/sb/rest/v1/todos', { headers: { Origin: EXE_ORIGIN } }), ENV, s.deps);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE_ORIGIN);
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('Date');
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('别的来源拿不到任何 CORS 头', async () => {
    const s = setup();
    const r = await handleSb(req('/sb/rest/v1/todos', { headers: { Origin: 'https://evil.example' } }), ENV, s.deps);
    expect([...r.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('预检直接 204、不转发；exe 来源带允许的方法和请求头', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos', { method: 'OPTIONS', headers: { Origin: EXE_ORIGIN } }), ENV, s.deps);
    expect(r.status).toBe(204);
    expect(s.fetchStub).not.toHaveBeenCalled();
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE_ORIGIN);
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PATCH, PUT, DELETE, OPTIONS');
    expect(r.headers.get('Access-Control-Max-Age')).toBe('600');
    const allow = (r.headers.get('Access-Control-Allow-Headers') ?? '').split(', ');
    expect(allow).toEqual([...ALLOW_HEADERS]);
    expect(allow).toContain('x-app-version');
    expect(allow).toContain('x-vault-token');
  });

  it('别的来源的预检：204 但没有 CORS 头', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), ENV, s.deps);
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull();
  });

  it('上游连不上：502，带安全头和 CORS，日志只有错误码', async () => {
    const s = setup({ upstream: async () => Promise.reject(new TypeError('network')) });
    const r = await handleSb(req('/sb/rest/v1/todos?token=secret', { headers: { Origin: EXE_ORIGIN } }), ENV, s.deps);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ code: 'upstream_unreachable' });
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE_ORIGIN);
    expect(s.log).toHaveBeenCalledWith('sb_upstream_unreachable');
    for (const call of s.log.mock.calls) expect(JSON.stringify(call)).not.toContain('token');
  });

  it('上游的 3xx 原样返回（不跟随）', async () => {
    const s = setup({ upstream: async () => new Response(null, { status: 303, headers: { Location: 'https://lemomemo.com/app/' } }) });
    const r = await handleSb(req('/sb/auth/v1/verify?token=x&type=magiclink'), ENV, s.deps);
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toBe('https://lemomemo.com/app/');
    expect(s.first().redirect).toBe('manual');
  });

  it('缺配置：500 proxy_misconfigured，不转发', async () => {
    const s = setup();
    const r = await handleSb(req('/sb/rest/v1/todos'), { ...ENV, PROXY_SECRET: '' }, s.deps);
    expect(r.status).toBe(500);
    expect(s.fetchStub).not.toHaveBeenCalled();
  });
});

describe('写入先查版本（TC-B0-46～48、51 经转发层）', () => {
  it('TC-B0-46：PATCH 不带版本头 → 426，不转发，带安全头和 CORS 头', async () => {
    const s = setup({ min: '4.0.0' });
    const r = await handleSb(
      new Request(BASE + '/sb/rest/v1/todos?id=eq.1', { method: 'PATCH', body: '{}', headers: { Origin: EXE_ORIGIN } }),
      ENV,
      s.deps,
    );
    expect(r.status).toBe(426);
    expect(await r.json()).toEqual({ code: 'upgrade_required', min: '4.0.0' });
    expect(s.fetchStub).not.toHaveBeenCalled();
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE_ORIGIN);
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
  });

  it.each([
    ['3.9.9', 426],
    ['4.0.0', 200],
    ['4.0.1', 200],
  ])('TC-B0-47：%s → %i', async (v, status) => {
    const s = setup({ min: '4.0.0' });
    const r = await handleSb(req('/sb/rest/v1/todos', { method: 'PATCH', body: '{}', headers: { 'X-App-Version': v } }), ENV, s.deps);
    expect(r.status).toBe(status);
  });

  it.each([
    ['4.1.0-preview.3', 200],
    ['4.0.9-preview.9', 426],
  ])('TC-B0-48：min 4.1.0，%s → %i', async (v, status) => {
    const s = setup({ min: '4.1.0' });
    const r = await handleSb(req('/sb/rest/v1/todos', { method: 'POST', body: '{}', headers: { 'X-App-Version': v } }), ENV, s.deps);
    expect(r.status).toBe(status);
  });

  it.each([
    ['POST', '/sb/auth/v1/otp'],
    ['POST', '/sb/storage/v1/object/sign/images/a.webp'],
    ['POST', '/sb/storage/v1/object/list/images'],
    ['GET', '/sb/rest/v1/todos'],
  ])('TC-B0-51：不带版本头 %s %s 照常转发', async (m, p) => {
    const s = setup({ min: '9.9.9' });
    const r = await handleSb(new Request(BASE + p, { method: m, ...(m === 'GET' ? {} : { body: '{}' }) }), ENV, s.deps);
    expect(r.status).toBe(200);
    expect(s.fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('WebSocket（Realtime）', () => {
  it('Upgrade: websocket 只允许 /realtime/v1/，不查版本，直接透传', async () => {
    // Node 里造不出 101，用 200 代替检查“原样返回”
    const upstreamResp = new Response(null, { status: 200, headers: { 'x-upstream': '1' } });
    const s = setup({ min: '9.9.9', upstream: async () => upstreamResp });
    const r = await handleSb(new Request(BASE + '/sb/realtime/v1/websocket?apikey=a&vsn=1.0.0', { headers: { Upgrade: 'websocket' } }), ENV, s.deps);
    expect(r).toBe(upstreamResp);
    expect(s.first().headers.get('upgrade')).toBe('websocket');
    expect(s.first().headers.get('x-proxy-secret')).toBe(ENV.PROXY_SECRET);
  });

  it('别的路径带 Upgrade 一律 404', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos', { headers: { Upgrade: 'websocket' } }), ENV, s.deps);
    expect(r.status).toBe(404);
    expect(s.fetchStub).not.toHaveBeenCalled();
  });
});

describe('日志不打印 URL（14.2 第 8 点）', () => {
  it('转发正常时一条日志都不写', async () => {
    const s = setup();
    const spy = vi.spyOn(console, 'log');
    await handleSb(req('/sb/storage/v1/object/sign/images/a.webp?token=abc'), ENV, s.deps);
    expect(s.log).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
