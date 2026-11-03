// push-test（B2 任务单 BE-6；架构第 6 节 push-test 行；安全审查 D1-5、TC-B2-80、85）：core.ts 的 handle 接真的 buildPayload、deliver、loadVapid，
// 推送服务用进程内替身（tests/fakes/push-service.ts，解密、核 VAPID）。鉴权、限流、设备查询用假的 store。
import { describe, expect, it } from 'vitest';
import { buildPayload } from '../../supabase/functions/_shared/push/payload.ts';
import { deliver } from '../../supabase/functions/_shared/push/send.ts';
import { VapidSigner } from '../../supabase/functions/_shared/push/vapid.ts';
import { handle, HOURLY_LIMIT, rateKey, TEST_RESULTS, toTestResult, WINDOW_S, type Deps, type TestDevice } from '../../supabase/functions/push-test/core.ts';
import { createFakePush, newPushSubscriber, reply, type FakePushService, type PushSubscriber } from '../fakes/push-service.ts';
import { fakeVapid } from './push-dispatch-harness.ts';

const UA = '0a1b2c3d-1111-4222-8333-444455556666';
const UB = '0a1b2c3d-1111-4222-8333-777788889999';
/** counters 的 check 约束（0001） */
const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;
const req = (method = 'POST') => new Request('http://kong:8000/functions/v1/push-test', { method, headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : null });

let n = 0;
const did = () => `d0000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

async function world(paths: string[], opt: { rules?: { path: string; reply: ReturnType<typeof reply.gone> }[] } = {}) {
  const v = await fakeVapid();
  const subs: PushSubscriber[] = [];
  const devs: TestDevice[] = [];
  for (const p of paths) {
    const ep = `https://fcm.googleapis.com/fcm/send/${p}`;
    const s = await newPushSubscriber(ep);
    subs.push(s);
    devs.push({ id: did(), push_endpoint: ep, p256dh: s.p256dh, auth: s.auth });
  }
  const f: FakePushService = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, rules: opt.rules ?? [] });
  const counts = new Map<string, number>();
  const codes: string[] = [];
  const asked: string[] = [];
  const deps = (over: Partial<Deps> = {}): Deps => ({
    authenticate: async () => ({ ok: true, user: { userId: UA, sessionId: 's', jwt: 'j' } }),
    store: {
      async takeRate(key, limit, windowS) {
        expect(COUNTER_KEY.test(key)).toBe(true);
        expect([limit, windowS]).toEqual([HOURLY_LIMIT, WINDOW_S]);
        const c = (counts.get(key) ?? 0) + 1;
        counts.set(key, c);
        return c <= limit;
      },
      async devices(userId) {
        asked.push(userId);
        return userId === UA ? devs : [];
      },
    },
    override: { ok: true, url: null },
    vapid: async () => ({ ok: true, keys: v.keys }),
    buildPayload,
    deliver: (dev, payload, o, keys, override) => deliver(dev, payload, o, { fetch: f.fetch, signer: new VapidSigner(keys, Date.now), override }),
    now: () => Date.UTC(2026, 10, 3, 7, 30),
    log: (c) => codes.push(c),
    ...over,
  });
  return { f, devs, deps, counts, codes, asked };
}

const body = async (r: Response) => (await r.json()) as { results?: { device_id: string; result: string }[]; error?: string };

describe('push-test', () => {
  it('给本人每台设备发一条 test：负载正好 {v, type, user_id}、补齐到 1024 一档、VAPID 有效；回每台的枚举结果；不带 CORS 头、no-store', async () => {
    const w = await world(['a', 'b']);
    const r = await handle(req(), w.deps());
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ results: w.devs.map((d) => ({ device_id: d.id, result: 'ok' })) });
    expect(w.asked).toEqual([UA]);
    expect(w.f.requests).toHaveLength(2);
    for (const q of w.f.requests) {
      expect(JSON.parse(q.payload as string)).toEqual({ v: 1, type: 'test', user_id: UA });
      expect(q.vapid?.ok).toBe(true);
      expect(q.bodyBytes).toBe(1024 + 86 + 16);   // 补齐后 1024 + 头 86 + 标签 16（ece.ts）
    }
    expect([...r.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('D1-5：结果只有 ok、gone、failed、bad_endpoint——410 → gone，401、413、429、3xx、500 → failed；不合格端点、坏钥匙 → bad_endpoint，推送服务一次都没被访问；不回状态码、端点', async () => {
    const w = await world(['ok', 'gone', 'v401', 'big', 'slow', 'redir', 'boom'], {
      rules: [
        { path: '/fcm/send/gone', reply: reply.gone() },
        { path: '/fcm/send/v401', reply: reply.status(401) },
        { path: '/fcm/send/big', reply: reply.status(413) },
        { path: '/fcm/send/slow', reply: reply.tooMany(60) },
        { path: '/fcm/send/redir', reply: reply.redirect('http://127.0.0.1:9/x', 302) },
        { path: '/fcm/send/boom', reply: reply.status(500) },
      ],
    });
    const badHost: TestDevice = { id: did(), push_endpoint: 'https://evil.example.com/fcm/send/x', p256dh: w.devs[0]?.p256dh ?? null, auth: w.devs[0]?.auth ?? null };
    const badKeys: TestDevice = { id: did(), push_endpoint: 'https://fcm.googleapis.com/fcm/send/k', p256dh: 'BAD', auth: 'BAD' };
    w.devs.push(badHost, badKeys);
    const r = await handle(req(), w.deps());
    const b = await body(r);
    expect(b.results?.map((x) => x.result)).toEqual(['ok', 'gone', 'failed', 'failed', 'failed', 'failed', 'failed', 'bad_endpoint', 'bad_endpoint']);
    for (const x of b.results ?? []) {
      expect(Object.keys(x).sort()).toEqual(['device_id', 'result']);
      expect(TEST_RESULTS).toContain(x.result);
    }
    expect(w.f.requests.map((q) => q.path)).not.toContain('/fcm/send/k');
    expect(w.f.requests.some((q) => q.url.includes('evil'))).toBe(false);
    expect(w.f.requests.some((q) => q.viaRedirect)).toBe(false);
    const text = JSON.stringify(b);
    for (const s of ['401', '413', '429', '302', '500', 'fcm.googleapis.com', 'evil', 'timeout', 'network', 'redirect']) expect(text).not.toContain(s);
  });

  it('枚举收拢：deliver 的每种结果都落进四种之一', () => {
    const all = ['ok', 'gone', 'vapid_rejected', 'too_large', 'rate_limited', 'redirect', 'timeout', 'network', 'failed', 'bad_keys', 'payload_too_large'] as const;
    expect(all.map((o) => toTestResult({ outcome: o } as never))).toEqual(['ok', 'gone', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'bad_endpoint', 'failed']);
    expect(toTestResult({ outcome: 'bad_endpoint', reason: 'host_not_allowed' })).toBe('bad_endpoint');
  });

  it('每人每小时 5 次：第 6 次回 429、一条不发；计数键 push-test:<user_id>:<UTC 小时> 过得了 counters 约束；换一个小时重新计', async () => {
    const w = await world(['a']);
    for (let i = 0; i < HOURLY_LIMIT; i++) expect((await handle(req(), w.deps())).status).toBe(200);
    const r6 = await handle(req(), w.deps());
    expect(r6.status).toBe(429);
    expect(await body(r6)).toEqual({ error: 'rate_limited' });
    expect(w.f.requests).toHaveLength(HOURLY_LIMIT);
    expect(rateKey(UA, Date.UTC(2026, 10, 3, 7, 30))).toBe(`push-test:${UA}:2026110307`);
    expect((await handle(req(), w.deps({ now: () => Date.UTC(2026, 10, 3, 8, 0) }))).status).toBe(200);
  });

  it('只给调用者本人：别人的设备不查、不发；没有设备回空列表', async () => {
    const w = await world(['a']);
    const r = await handle(req(), w.deps({ authenticate: async () => ({ ok: true, user: { userId: UB, sessionId: 's', jwt: 'j' } }) }));
    expect(await body(r)).toEqual({ results: [] });
    expect(w.asked).toEqual([UB]);
    expect(w.f.requests).toHaveLength(0);
  });

  it('鉴权不过：原样回鉴权的响应，不扣次数、不查设备', async () => {
    const w = await world(['a']);
    const r = await handle(req(), w.deps({ authenticate: async () => ({ ok: false, code: 'session_revoked', response: new Response('{"error":"session_revoked"}', { status: 401 }) }) }));
    expect(r.status).toBe(401);
    expect(w.counts.size).toBe(0);
    expect(w.asked).toEqual([]);
  });

  // TC-B1-10 / TC-B1-109 覆盖（fn-account-disabled-coverage）：鉴权由 index.ts 接 requireActiveUser（停用、没有 profile 的抛 account_disabled 403），
  // 这里核对 core 把它原样回给调用方、一条不发
  it('TC-B1-10 push-test：管理员停用的账号回 403 account_disabled，不扣次数、不查设备、不发', async () => {
    const w = await world(['a']);
    const r = await handle(req(), w.deps({ authenticate: async () => ({ ok: false, code: 'account_disabled', response: new Response('{"error":"account_disabled"}', { status: 403 }) }) }));
    expect(r.status).toBe(403);
    expect(await body(r)).toEqual({ error: 'account_disabled' });
    expect([w.counts.size, w.asked.length, w.f.requests.length]).toEqual([0, 0, 0]);
  });
  it('TC-B1-10 push-test：没有 profiles 行的账号回 403 account_disabled，不扣次数、不查设备、不发', async () => {
    const w = await world(['a']);
    const r = await handle(req(), w.deps({ authenticate: async () => ({ ok: false, code: 'account_disabled', response: new Response('{"error":"account_disabled"}', { status: 403 }) }) }));
    expect(r.status).toBe(403);
    expect(await body(r)).toEqual({ error: 'account_disabled' });
    expect([w.counts.size, w.asked.length, w.f.requests.length]).toEqual([0, 0, 0]);
  });

  it('线上设了替身（override 不合格）、VAPID 不对：验完 JWT 后回 500 misconfigured，不扣次数、一条不发；日志只记错误码', async () => {
    const w = await world(['a']);
    const r1 = await handle(req(), w.deps({ override: { ok: false } }));
    expect([r1.status, await body(r1)]).toEqual([500, { error: 'misconfigured' }]);
    const r2 = await handle(req(), w.deps({ vapid: async () => ({ ok: false, reason: 'vapid_keypair_mismatch' }) }));
    expect([r2.status, await body(r2)]).toEqual([500, { error: 'misconfigured' }]);
    expect(w.counts.size).toBe(0);
    expect(w.f.requests).toHaveLength(0);
    expect(w.codes).toEqual(['misconfigured:override', 'misconfigured:vapid_keypair_mismatch']);
    const auth = await handle(req(), w.deps({ override: { ok: false }, authenticate: async () => ({ ok: false, code: 'unauthorized', response: new Response(null, { status: 401 }) }) }));
    expect(auth.status).toBe(401);
  });

  it('本机替身：改投替身地址，aud 仍按真实端点的 origin', async () => {
    const w = await world(['a']);
    const seen: string[] = [];
    const r = await handle(req(), w.deps({
      override: { ok: true, url: 'http://127.0.0.1:56490' },
      deliver: (dev, payload, o, keys, override) => deliver(dev, payload, o, { fetch: (u) => { seen.push(u); return Promise.resolve(new Response(null, { status: 201 })); }, signer: new VapidSigner(keys, Date.now), override }),
    }));
    expect((await body(r)).results?.map((x) => x.result)).toEqual(['ok']);
    expect(seen).toEqual(['http://127.0.0.1:56490']);
  });

  it('take_rate、查设备出错：503 try_later，不发', async () => {
    const w = await world(['a']);
    const boom = async () => { throw new Error('db'); };
    const r1 = await handle(req(), w.deps({ store: { takeRate: boom, devices: async () => w.devs } }));
    const r2 = await handle(req(), w.deps({ store: { takeRate: async () => true, devices: boom } }));
    expect([r1.status, r2.status]).toEqual([503, 503]);
    expect(w.f.requests).toHaveLength(0);
  });

  it('只收 POST', async () => {
    const w = await world([]);
    expect((await handle(req('GET'), w.deps())).status).toBe(405);
  });
});
