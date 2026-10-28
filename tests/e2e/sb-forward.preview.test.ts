// 第 9 节“Worker 转发”：经预览环境 /sb/* 的真实链路（TC-B0-43，另含 TC-B0-39、46 的线上复核）。
// 【待预览环境】没有下面的环境变量时整组跳过。前端 B 牵头联调；Realtime 经 Pages Functions 能不能透传 WebSocket 以这里的结果为准，
// 不行就退回独立 Worker 路由（14.2 第 9 点）。
//
// 环境变量（只放 GitHub e2e-preview 环境；值不打印、不进报告）：
//   PREVIEW_BASE        例如 https://preview.lemomemo.com
//   PREVIEW_ANON_KEY    预览项目的 anon / publishable key
//   PREVIEW_USER_JWT    准备步骤按 0.29 续第 89 条拿到的 .test 测试账号的访问令牌（先 ::add-mask::）
//   PREVIEW_USER_ID     同一个账号的 user_id
//   PREVIEW_FN_PROBE    （可选）一个存在的函数名，用来看函数是不是跑在首尔
//   PREVIEW_OTP_EMAIL   （可选）发验证码用的 @lemomemo.test 邮箱
import { describe, expect, it } from 'vitest';

const env = process.env;
const BASE = env.PREVIEW_BASE ?? '';
const ANON = env.PREVIEW_ANON_KEY ?? '';
const JWT = env.PREVIEW_USER_JWT ?? '';
const UID = env.PREVIEW_USER_ID ?? '';
const ready = !!(BASE && ANON && JWT && UID);
const VERSION = '4.0.0-preview.0';

function sb(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const h = new Headers(init.headers);
  h.set('apikey', ANON);
  if (auth) h.set('Authorization', `Bearer ${JWT}`);
  if (!h.has('X-App-Version')) h.set('X-App-Version', VERSION);
  return fetch(`${BASE}/sb${path}`, { ...init, headers: h, redirect: 'manual' });
}

describe.skipIf(!ready)('【待预览环境】/sb/* 转发', () => {
  it('REST：读 app_config（anon 能读的几列）', async () => {
    const r = await sb('/rest/v1/app_config?select=min_client_version', {}, false);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    const rows: unknown = await r.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('REST：写一条测试数据再读回（settings；列名以 0001 迁移为准）', async () => {
    const key = `e2e.sb_forward.${Date.now()}`;
    const w = await sb('/rest/v1/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: UID, key, value: { ok: true } }),
    });
    expect(w.status).toBe(201);
    const r = await sb(`/rest/v1/settings?select=key&key=eq.${encodeURIComponent(key)}`);
    expect(await r.json()).toEqual([{ key }]);
    // 收尾：软删除（客户端没有 DELETE 授权，0.29 续第 121 条）
    await sb(`/rest/v1/settings?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    });
  });

  it('TC-B0-46（线上）：写入不带版本头 → 426，带 CORS 和安全头', async () => {
    const r = await fetch(`${BASE}/sb/rest/v1/settings?key=eq.none`, {
      method: 'PATCH',
      headers: { apikey: ANON, Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json', Origin: 'http://tauri.localhost' },
      body: '{}',
    });
    expect(r.status).toBe(426);
    expect((await r.json()) as unknown).toMatchObject({ code: 'upgrade_required' });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
  });

  it('TC-B0-39（线上）：白名单外和穿越 → 404', async () => {
    for (const p of ['/graphql/v1', '/rest/v1/', '/auth/v1/admin/users']) {
      expect((await sb(p, {}, false)).status).toBe(404);
    }
  });

  it.skipIf(!env.PREVIEW_OTP_EMAIL)('Auth：经 /sb/ 发验证码', async () => {
    const email = env.PREVIEW_OTP_EMAIL ?? '';
    expect(email.endsWith('@lemomemo.test')).toBe(true); // 护栏：只给 .test 邮箱发（0.29 续第 91 条）
    const r = await sb('/auth/v1/otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: false }) }, false);
    // Turnstile 全局开启后（B1）没有令牌会被拒；B0 只确认请求经转发到了 Auth
    expect([200, 400, 422, 429]).toContain(r.status);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
  });

  it.todo('Auth：校验验证码（用准备步骤 generateLink 拿到的 email_otp，B1 Turnstile 定了再写全）');

  // QA D-11：架构 0.32 把“Storage 签名链接是相对路径”从 TC-B0-43 划掉（照片和附件改走 /files，/sb 的存储只留 vault-preview 的 GET）。
  // 这里改成核对线上收窄确实生效（TC-B0-119 的预览部分），以及架构 0.33 第 10 条“路径里有 % 一律本地 404”在线上也成立
  // （QA 待实测第 24 项：Cloudflare 边缘会不会先把 %61 这类编码解开；不管解不解开，结果都必须是转发层自己回的 not_found）。
  it('Storage：除 vault-preview 的 GET 以外一律本地 404；路径带 % 的（四条反例）也是本地 404', async () => {
    const path = `${UID}/${crypto.randomUUID()}/${crypto.randomUUID()}.webp`;
    const up = await sb(`/storage/v1/object/images/${path}`, { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: 'x' });
    expect(up.status).toBe(404);
    expect(await up.json()).toEqual({ code: 'not_found' });
    for (const p of ['/rest/v1/rpc/files%5Fauthorize', '/rest/v1/rpc/%66iles_authorize', '/auth/v1/%61dmin/users', '/auth/v1/adm%69n']) {
      const r = await sb(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(r.status, p).toBe(404);
      expect(await r.json(), p).toEqual({ code: 'not_found' }); // 转发层回的，不是上游的 404
    }
  });

  it.skipIf(!env.PREVIEW_FN_PROBE)('Functions：固定在首尔运行', async () => {
    const r = await sb(`/functions/v1/${env.PREVIEW_FN_PROBE}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.headers.get('x-sb-edge-region')).toBe('ap-northeast-2');
  });

  it.todo('x-proxy-secret 不对时函数不信 x-client-ip、x-lemo-geo（要 account 函数，B1 和 TC-B0-91 一起测）');

  it('Realtime：经 /sb/ 连上 WebSocket，并收到一条改动', async () => {
    const wsUrl = `${BASE.replace(/^http/, 'ws')}/sb/realtime/v1/websocket?apikey=${encodeURIComponent(ANON)}&vsn=1.0.0`;
    const ws = new WebSocket(wsUrl);
    const topic = 'realtime:e2e-sb-forward';
    const got = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('realtime_timeout')), 20_000);
      ws.addEventListener('error', () => reject(new Error('ws_error')));
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            topic,
            event: 'phx_join',
            ref: '1',
            payload: {
              access_token: JWT,
              config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'settings', filter: `user_id=eq.${UID}` }] },
            },
          }),
        );
      });
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as { event: string; payload?: { status?: string } };
        if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
          void sb('/rest/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: UID, key: `e2e.realtime.${Date.now()}`, value: {} }),
          });
        }
        if (msg.event === 'postgres_changes') {
          clearTimeout(timer);
          resolve(msg.event);
        }
      });
    });
    try {
      expect(await got).toBe('postgres_changes');
    } finally {
      ws.close();
    }
  }, 30_000);
});
