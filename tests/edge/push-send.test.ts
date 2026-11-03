// _shared/push/send.ts 的 deliver（B2 第一天派工表第 4 行；B2 安全审查第五节第 4～8 条、1.5 第 ② 点 D1-8）：推送服务用测试开发的替身 tests/fakes/push-service.ts，
// 进程内注入 fake.fetch（D3 第 6 点）；“3xx 的 Location 指向别的端口、那个端口一次都没被访问”这一条开两个本机端口、用真 fetch。
// 钥匙一律现生成的假 VAPID（用完即丢）。handle、替身判断在 push-dispatch.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { classify, deliver, MAX_RESPONSE_BYTES, type DeliverCtx, type FetchLike } from '../../supabase/functions/_shared/push/send.ts';
import { loadVapid, VapidSigner, type VapidKeys } from '../../supabase/functions/_shared/push/vapid.ts';
import { fx } from '../build/push-endpoints-fixture-load.ts';
import { b64u, createFakePush, newPushSubscriber, reply, unb64u, type FakePushService } from '../fakes/push-service.ts';

const te = new TextEncoder();
const FCM = 'https://fcm.googleapis.com';

async function fakeVapid(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array([4, ...unb64u(j.x ?? ''), ...unb64u(j.y ?? '')]));
  return { priv: JSON.stringify({ kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y }), pub };
}

async function keys(): Promise<{ keys: VapidKeys; pub: string }> {
  const v = await fakeVapid();
  const r = await loadVapid(v.priv, v.pub, 'https://lemomemo.com');
  if (!r.ok) throw new Error(r.reason);
  return { keys: r.keys, pub: v.pub };
}

// ---------------- 发送（_shared/push/send.ts 的 deliver）----------------

let fakes: FakePushService[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});
function fake(...a: Parameters<typeof createFakePush>): FakePushService {
  const f = createFakePush(...a);
  fakes.push(f);
  return f;
}

const OPT = { ttl: 3600, urgency: 'normal' as const };

async function setup(override: string | null = null, fetchImpl?: FetchLike) {
  const endpoint = `${FCM}/fcm/send/abc:APA91b`;
  // 订阅方带上真实端点：改投替身时替身按它的源核 aud（替身复核 N3，没带就记 aud_unbound、回 403）
  const sub = await newPushSubscriber(endpoint);
  const k = await keys();
  const f = fake({ subscribers: [sub], vapid: { publicKey: k.pub } });
  const ctx: DeliverCtx = { fetch: fetchImpl ?? f.fetch, signer: new VapidSigner(k.keys, Date.now), override };
  const dev = { push_endpoint: endpoint, p256dh: sub.p256dh, auth: sub.auth };
  return { sub, f, ctx, dev };
}

describe('deliver：经替身发通一条（推送服务一侧验签、解密）', () => {
  it('ok：原样用通过校验的地址；VAPID 验签过、aud 是真实端点的 origin；解出原文；带 TTL、Urgency、aes128gcm；不带 Cookie', async () => {
    const { f, ctx, dev } = await setup();
    const payload = JSON.stringify({ kind: 'todo', title: '买柠檬' });
    expect(await deliver(dev, te.encode(payload), OPT, ctx)).toEqual({ outcome: 'ok' });
    expect(f.requests).toHaveLength(1);
    const r = f.requests[0];
    if (!r) throw new Error('没收到请求');
    expect(r.url).toBe(dev.push_endpoint);
    expect(r.vapid?.ok).toBe(true);
    expect(r.vapid?.ok && r.vapid.claims.aud).toBe(FCM);
    expect(r.payload).toBe(payload);
    expect(r.headers.ttl).toBe('3600');
    expect(r.headers.urgency).toBe('normal');
    expect(r.headers['content-encoding']).toBe('aes128gcm');
    expect(r.headers.cookie).toBeUndefined();
    expect(r.bodyBytes).toBe(86 + 1024 + 16);   // 补齐到第一档
  });
  it('改投替身（D1-8）：请求打到替身地址，真实端点一次都不连；aud 仍按真实端点签', async () => {
    const { f, ctx, dev } = await setup('http://host.docker.internal:54399/push');
    expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'ok' });
    expect(f.requests.map((r) => r.url)).toEqual(['http://host.docker.internal:54399/push']);
    expect(f.requests[0]?.vapid?.ok && f.requests[0].vapid.claims.aud).toBe(FCM);
  });
  it('不合格的端点、密钥：不加密、不发（bad_endpoint 只带原因码；调用方置空三列、记 push_bad_endpoint）；替身模式也先查白名单', async () => {
    for (const override of [null, 'http://127.0.0.1:54399']) {
      const { f, ctx, dev } = await setup(override);
      expect(await deliver({ ...dev, push_endpoint: 'https://evil.example/x' }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_endpoint', reason: 'host_not_allowed' });
      expect(await deliver({ ...dev, push_endpoint: null }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_endpoint', reason: 'bad_format' });
      expect(await deliver({ ...dev, p256dh: 'AA' + 'A'.repeat(85) }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_keys' });
      expect(await deliver({ ...dev, auth: null }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_keys' });
      expect(f.requests).toHaveLength(0);
    }
  });
  it('点不在曲线上（正则查不出）：加密时 bad_keys，不发', async () => {
    const { f, ctx, dev } = await setup();
    const p = 'BA' + 'A'.repeat(84) + 'E';   // 合正则（首字节 0x04）但 (0,…) 不在 P-256 上
    expect(await deliver({ ...dev, p256dh: p }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_keys' });
    expect(f.requests).toHaveLength(0);
  });
  it.each(fx.keysSendOnly.map((k) => [k.id, k] as const))('fixture keysSendOnly %s：正则和 SQL 都收，发送时 bad_keys、不发', async (_, k) => {
    const { f, ctx, dev } = await setup();
    expect(await deliver({ ...dev, p256dh: k.value }, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'bad_keys' });
    expect(f.requests).toHaveLength(0);
  });
  it('S11：topic 合格（≤ 32 个 base64url 字符）原样带上；不合格（太长、带别的字符、空串）不发、算 failed', async () => {
    const { f, ctx, dev } = await setup();
    expect(await deliver(dev, te.encode('x'), { ...OPT, topic: 'todo_0b9f3c2e-1111' }, ctx)).toEqual({ outcome: 'ok' });
    expect(f.requests[0]?.headers.topic).toBe('todo_0b9f3c2e-1111');
    for (const topic of ['a'.repeat(33), 'a b', 'a/b', 'a=', '']) {
      expect(await deliver(dev, te.encode('x'), { ...OPT, topic }, ctx)).toEqual({ outcome: 'failed' });
    }
    expect(f.requests).toHaveLength(1);
  });
  it('正文超过 3 KB 一档：payload_too_large，不发', async () => {
    const { f, ctx, dev } = await setup();
    expect(await deliver(dev, new Uint8Array(3072), OPT, ctx)).toEqual({ outcome: 'payload_too_large' });
    expect(f.requests).toHaveLength(0);
  });
});

describe('deliver：按状态归类（只给枚举，不回状态码、响应头、响应体）', () => {
  it.each([
    [201, 'ok'], [202, 'ok'], [404, 'gone'], [410, 'gone'], [401, 'vapid_rejected'], [403, 'vapid_rejected'],
    [413, 'too_large'], [429, 'rate_limited'], [400, 'failed'], [500, 'failed'], [503, 'failed'],
  ] as const)('%i → %s', async (status, outcome) => {
    const { f, ctx, dev } = await setup();
    f.setDefault(reply.status(status, {}, 'body'));
    expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome });
  });
  it('301、302、303、307、308 都算失败（redirect），不跟随：替身只收到一次请求，没有打到 REDIRECT_TARGET', async () => {
    for (const s of [301, 302, 303, 307, 308] as const) {
      const { f, ctx, dev } = await setup();
      f.setDefault(reply.redirect(undefined, s));
      expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'redirect' });
      expect(f.requests).toHaveLength(1);
      expect(f.requests.some((r) => r.viaRedirect)).toBe(false);
    }
  });
  it('classify：opaqueredirect、状态 0、任何 3xx 都是 redirect（Deno 的 manual 拿到的是 basic 的 307，三种都要判）', () => {
    expect(classify(0, 'opaqueredirect')).toBe('redirect');
    expect(classify(0, 'basic')).toBe('redirect');
    expect(classify(307, 'basic')).toBe('redirect');
    expect(classify(399, 'cors')).toBe('redirect');
    expect(classify(200, 'opaqueredirect')).toBe('redirect');
  });
  it('网络错误 → network；超时（TimeoutError / AbortError）→ timeout', async () => {
    const boom = (name: string): FetchLike => async () => { throw Object.assign(new Error(name), { name }); };
    for (const [name, outcome] of [['TypeError', 'network'], ['TimeoutError', 'timeout'], ['AbortError', 'timeout']] as const) {
      const { ctx, dev } = await setup(null, boom(name));
      expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome });
    }
  });
  it('替身挂住不回：5 秒后放弃，算 timeout', async () => {
    const { f, ctx, dev } = await setup();
    f.setDefault(reply.hang());
    const t0 = Date.now();
    expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThan(4500);
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 15_000);
  it('响应体最多读 1 KB 就 cancel（推送服务回一个没完没了的响应体也不会拖住）', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 256;
        c.enqueue(new Uint8Array(256));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }), { status: 201 });
    const { ctx, dev } = await setup(null, endless);
    expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'ok' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(MAX_RESPONSE_BYTES + 1024);
  });
});

describe('真 fetch + 本机端口：302 的 Location 指向另一个端口，那个端口一次都没被访问（1.5 第 ② 点测试最后一条）', () => {
  it('redirect: manual 不跟随，算失败', async () => {
    const other = fake();
    const otherOrigin = await other.listen(0);
    const first = fake();
    await first.listen(0);
    first.setDefault(reply.redirect(`${otherOrigin}/steal`, 302));
    const { ctx, dev } = await setup(first.overrideUrl('127.0.0.1', '/push'), (u, i) => fetch(u, i));
    expect(await deliver(dev, te.encode('x'), OPT, ctx)).toEqual({ outcome: 'redirect' });
    expect(first.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
  });
});
